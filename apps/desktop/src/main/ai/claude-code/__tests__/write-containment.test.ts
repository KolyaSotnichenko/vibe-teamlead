import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { evaluatePreToolUse } from '../security-hooks';
import type { ToolContext } from '../../tools/types';

const denied = (out: object) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';

// Outside the temp directory, which is itself an allowed root.
const scratch = mkdtempSync(join(homedir(), '.vtl-containment-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function worktree() {
  const root = mkdtempSync(join(scratch, 'wt-'));
  const specDir = join(root, '.vibe-teamlead', 'specs', '001');
  mkdirSync(specDir, { recursive: true });
  const context = { cwd: root, projectDir: root, specDir, securityProfile: undefined as never } as ToolContext;
  return { root, specDir, context };
}

describe('write containment', () => {
  it('keeps agents from writing requests that only the app or the user may make', () => {
    const context = { cwd: scratch, projectDir: scratch, specDir: scratch } as unknown as ToolContext;
    for (const name of ['QA_FIX_REQUEST.md', 'QA_RERUN']) {
      expect(denied(evaluatePreToolUse('Write', { file_path: join(context.specDir, name) }, context))).toBe(true);
      expect(denied(evaluatePreToolUse('Edit', { file_path: join(context.specDir, name) }, context))).toBe(true);
      // The macOS file system ignores case, and a path can end in a way basename alone misreads
      expect(denied(evaluatePreToolUse('Write', { file_path: join(context.specDir, name.toLowerCase()) }, context))).toBe(true);
      expect(denied(evaluatePreToolUse('Write', { file_path: `${name}/.` }, context))).toBe(true);
    }
  });

  it('lets a coder write inside its worktree and spec, not elsewhere', () => {
    const { root, context } = worktree();
    expect(denied(evaluatePreToolUse('Write', { file_path: 'src/app.ts' }, context))).toBe(false);
    expect(denied(evaluatePreToolUse('Edit', { file_path: join(root, 'README.md') }, context))).toBe(false);
    expect(denied(evaluatePreToolUse('Write', { file_path: join(homedir(), '.zshrc') }, context))).toBe(true);
    expect(denied(evaluatePreToolUse('Write', { file_path: '../outside.txt' }, context))).toBe(true);
  });

  it('blocks writes through a symlink that points outside the worktree', () => {
    const { root, context } = worktree();
    const outside = mkdtempSync(join(scratch, 'outside-'));
    symlinkSync(outside, join(root, 'escape'));
    expect(denied(evaluatePreToolUse('Write', { file_path: 'escape/evil.sh' }, context))).toBe(true);
  });

  describe('QA reviewer', () => {
    const reason = (out: object) =>
      (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? '';
    const reviewer = () => {
      const wt = worktree();
      return { ...wt, context: { ...wt.context, agentType: 'qa_reviewer' } as ToolContext };
    };

    it('writes its report, the spec checklists and screenshots inside the spec directory', () => {
      const { specDir, context } = reviewer();
      expect(denied(evaluatePreToolUse('Write', { file_path: join(specDir, 'qa_report.md') }, context))).toBe(false);
      expect(denied(evaluatePreToolUse('Edit', { file_path: join(specDir, 'spec.md') }, context))).toBe(false);
      expect(denied(evaluatePreToolUse('Write', { file_path: join(specDir, 'qa-browser', 'login.png') }, context))).toBe(false);
      expect(denied(evaluatePreToolUse('Write', { file_path: '.vibe-teamlead/specs/001/qa_report.md' }, context))).toBe(false);
    });

    it('cannot edit or create project code: that is a finding for the fixer', () => {
      const { root, specDir, context } = reviewer();
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        const out = evaluatePreToolUse(tool, { file_path: join(root, 'src', 'app.ts') }, context);
        expect(denied(out)).toBe(true);
        expect(reason(out)).toContain('qa_report.md');
        expect(reason(out)).toContain('QA fixer');
      }
      expect(denied(evaluatePreToolUse('NotebookEdit', { notebook_path: 'notebooks/a.ipynb' }, context))).toBe(true);
      expect(denied(evaluatePreToolUse('Write', { file_path: 'src/new-file.ts' }, context))).toBe(true);
      expect(denied(evaluatePreToolUse('Write', { file_path: join(specDir, '..', '..', '..', 'package.json') }, context))).toBe(true);
    });

    it('cannot stage or commit, but can still look at git', () => {
      const { context } = reviewer();
      for (const command of ['git commit -m "fix: thing"', 'git add .', 'git status && git commit -am x', 'cd src; git add -A', 'git -C /tmp/x commit --amend']) {
        const out = evaluatePreToolUse('Bash', { command }, context);
        expect(denied(out), command).toBe(true);
        expect(reason(out)).toContain('QA fixer');
      }
      for (const command of ['git diff main...HEAD --name-status', 'git status --short', 'git log --oneline -5', 'git stash list', 'npm test']) {
        expect(denied(evaluatePreToolUse('Bash', { command }, context)), command).toBe(false);
      }
    });

    it('leaves other agents as they were', () => {
      const { root, context } = worktree();
      for (const agentType of ['coder', 'qa_fixer', undefined]) {
        const ctx = { ...context, agentType } as ToolContext;
        expect(denied(evaluatePreToolUse('Write', { file_path: join(root, 'src', 'app.ts') }, ctx))).toBe(false);
        expect(denied(evaluatePreToolUse('Bash', { command: 'git add . && git commit -m "feat: x"' }, ctx))).toBe(false);
      }
    });
  });

  it('narrows to allowedWritePaths when set (architect, spec agents)', () => {
    const { root, specDir, context } = worktree();
    const architect = { ...context, allowedWritePaths: [specDir] };
    expect(denied(evaluatePreToolUse('Write', { file_path: join(specDir, 'architecture', 'architecture.md') }, architect))).toBe(false);
    expect(denied(evaluatePreToolUse('Write', { file_path: join(root, 'src', 'app.ts') }, architect))).toBe(true);
  });
});
