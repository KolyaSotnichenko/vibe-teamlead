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

    it('can only look at git: read-only subcommands pass, everything else is a finding for the fixer', () => {
      const { context } = reviewer();
      const deniedCommands = [
        'git commit -m "fix: thing"',
        'git add .',
        'git status && git commit -am x',
        'cd src; git add -A',
        'git -C /tmp/x commit --amend',
        'git -c alias.x=commit x',
        'git --config-env=alias.x=X x',
        'git --git-dir=/tmp/x/.git status',
        'sh -c "git commit -m x"',
        'bash -c "git status"',
        'eval "git add ."',
        'echo commit | xargs git',
        'env GIT_DIR=/x git status',
        'git branch -D x',
        'git branch -m old new',
        'git branch new-branch',
        'git stash',
        'git stash pop',
        'git checkout -- .',
        'git restore src/app.ts',
        'git reset --hard',
        'git push',
        'git remote add x https://example.com/x.git',
        'git worktree add ../x',
        'git tag v1',
        'git',
        // Options before the subcommand, other than the pager and lock ones
        'git --no-replace-objects status',
        'git --literal-pathspecs -c x=y diff',
        'GIT_DIR=/tmp/x git status',
        'PAGER="sh -c id" git log',
        // Options on allowed subcommands that write or run programs
        'git diff --output=/tmp/x',
        'git diff --output /tmp/x',
        'git log -O/tmp/orderfile',
        'git diff -O=/tmp/x',
        'git grep --open-files-in-pager',
        'git diff --ext-diff',
        'git diff --textconv',
        'git diff --no-index a b',
        // git hidden in a substitution, quotes or a second line
        'echo $(git commit -m x)',
        'echo `git add .`',
        "echo 'git add .' | sh",
        'echo "git commit"',
        'ls\ngit commit -m x',
      ];
      for (const command of deniedCommands) {
        const out = evaluatePreToolUse('Bash', { command }, context);
        expect(denied(out), command).toBe(true);
        expect(reason(out), command).toContain('QA fixer');
      }
      const allowedCommands = [
        'git diff main...HEAD --name-status',
        'git diff',
        'git status --short',
        'git log --oneline -5',
        'git show HEAD:package.json',
        'git rev-parse HEAD',
        'git ls-files src',
        'git blame -L 1,5 src/app.ts',
        'git grep -n TODO -- src',
        'git branch',
        'git branch --list',
        'git branch -a -v',
        'git branch --show-current',
        'git stash list',
        'git stash show -p stash@{0}',
        'git remote -v',
        'git worktree list',
        'git describe --tags',
        'git rev-list --count HEAD',
        'git cat-file -p HEAD',
        'git name-rev HEAD',
        'git merge-base HEAD main',
        'git status | head -20',
        'cd src && git diff --stat',
        'git --no-pager log -3',
        'git -P diff',
        'git --no-optional-locks status',
        'npm test',
        'echo "no version control here"',
      ];
      for (const command of allowedCommands) {
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
