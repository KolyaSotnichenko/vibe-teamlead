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
  const specDir = join(root, '.auto-claude', 'specs', '001');
  mkdirSync(specDir, { recursive: true });
  const context = { cwd: root, projectDir: root, specDir, securityProfile: undefined as never } as ToolContext;
  return { root, specDir, context };
}

describe('write containment', () => {
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

  it('narrows to allowedWritePaths when set (architect, spec agents)', () => {
    const { root, specDir, context } = worktree();
    const architect = { ...context, allowedWritePaths: [specDir] };
    expect(denied(evaluatePreToolUse('Write', { file_path: join(specDir, 'architecture', 'architecture.md') }, architect))).toBe(false);
    expect(denied(evaluatePreToolUse('Write', { file_path: join(root, 'src', 'app.ts') }, architect))).toBe(true);
  });
});
