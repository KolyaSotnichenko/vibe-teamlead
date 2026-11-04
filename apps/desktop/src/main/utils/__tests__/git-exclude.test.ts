import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { excludeFromGit } from '../git-exclude';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

describe('excludeFromGit', () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-exclude-')));
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
    mkdirSync(join(repo, '.vibe-teamlead', 'specs'), { recursive: true });
    writeFileSync(join(repo, '.vibe-teamlead', 'specs', 'plan.json'), '{}');
  });

  it("takes the app's folder out of status and git add -A, and leaves the user's changes in", () => {
    writeFileSync(join(repo, 'mine.txt'), 'work');
    excludeFromGit(repo, '.vibe-teamlead/');

    expect(git(repo, 'status', '--porcelain').trim()).toBe('?? mine.txt');
    git(repo, 'add', '-A');
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('mine.txt');
  });

  it("doesn't touch the project's files", () => {
    excludeFromGit(repo, '.vibe-teamlead/');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('adds the entry once, on a new line of an existing file', () => {
    const file = join(repo, '.git', 'info', 'exclude');
    writeFileSync(file, '.codegraph/');
    excludeFromGit(repo, '.vibe-teamlead/');
    excludeFromGit(repo, '.vibe-teamlead/');
    expect(readFileSync(file, 'utf-8')).toBe('.codegraph/\n.vibe-teamlead/\n');
  });

  it('covers the task worktrees too', () => {
    const worktree = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    mkdirSync(join(worktree, '.vibe-teamlead'));
    writeFileSync(join(worktree, '.vibe-teamlead', 'x'), '');
    excludeFromGit(worktree, '.vibe-teamlead/');
    expect(git(worktree, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'status', '--porcelain')).not.toContain('.vibe-teamlead');
  });

  it('does nothing outside a repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'vtl-plain-'));
    expect(() => excludeFromGit(plain, '.vibe-teamlead/')).not.toThrow();
  });
});
