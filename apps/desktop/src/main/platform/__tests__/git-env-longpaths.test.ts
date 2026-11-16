import { describe, expect, it } from 'vitest';

import { worktreeAddArgs, worktreeConfigCommands } from '../git-env';

describe('long paths for worktrees', () => {
  it('turns core.longpaths on for the checkout and the worktree on Windows only', () => {
    expect(worktreeAddArgs(['worktree', 'add', 'w', 'main'], 'win32')).toEqual(['-c', 'core.longpaths=true', 'worktree', 'add', 'w', 'main']);
    expect(worktreeAddArgs(['worktree', 'add', 'w', 'main'], 'darwin')).toEqual(['worktree', 'add', 'w', 'main']);
    expect(worktreeConfigCommands('win32')).toEqual([['config', 'core.longpaths', 'true']]);
    expect(worktreeConfigCommands('darwin')).toEqual([]);
  });
});
