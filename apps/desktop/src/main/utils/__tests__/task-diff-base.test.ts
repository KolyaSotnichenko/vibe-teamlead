import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { taskDiffBase } from '../task-diff-base';

describe('what a task is compared with', () => {
  function repo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diff-base-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    const commit = (file: string) => {
      writeFileSync(join(dir, file), 'x\n');
      git('add', '-A');
      git('commit', '-q', '-m', file);
    };
    return { dir, git, commit };
  }

  it("is where the task started: work merged later into main isn't the task deleting it", () => {
    const { dir, git, commit } = repo();
    commit('first.txt');
    git('checkout', '-q', '-b', 'task');
    commit('task.txt');
    git('checkout', '-q', 'main');
    commit('later-on-main.txt');
    git('checkout', '-q', 'task');

    const base = taskDiffBase('git', dir, 'main');

    expect(git('diff', '--name-status', base)).toBe('A\ttask.txt');
    expect(git('diff', '--name-status', 'main')).toContain('later-on-main.txt');
  });

  it('falls back to the branch when git cannot tell', () => {
    const { dir, commit } = repo();
    commit('first.txt');
    expect(taskDiffBase('git', dir, 'no-such-branch')).toBe('no-such-branch');
  });
});
