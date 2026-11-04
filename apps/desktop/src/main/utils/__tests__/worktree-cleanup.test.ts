import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { cleanupWorktree, makeTreeWritable } from '../worktree-cleanup';
import { isOwnWorktree } from '../../ipc-handlers/task/worktree-handlers';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env }).trim();

/** A project on branch `dev` (so `main` is deletable by git) with the task folder location. */
function project(): { dir: string; tasks: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vtl-cleanup-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.vibe-teamlead/\n');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'dev');
  const tasks = path.join(dir, '.vibe-teamlead', 'worktrees', 'tasks');
  mkdirSync(tasks, { recursive: true });
  return { dir, tasks };
}

const branches = (dir: string) => git(dir, 'branch', '--format=%(refname:short)').split('\n');

describe('cleanupWorktree', () => {
  it('removes a task worktree and its own branch', async () => {
    const { dir, tasks } = project();
    const wt = path.join(tasks, '001-x');
    git(dir, 'worktree', 'add', '-q', '-b', 'vibe-teamlead/001-x', wt, 'main');
    expect(isOwnWorktree(wt)).toBe(true);

    const result = await cleanupWorktree({ worktreePath: wt, projectPath: dir, specId: '001-x' });

    expect(result.success).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(branches(dir)).not.toContain('vibe-teamlead/001-x');
    expect(branches(dir)).toContain('main');
  });

  it('never deletes the project branch for a leftover folder that is no longer a worktree', async () => {
    const { dir, tasks } = project();
    const leftover = path.join(tasks, '002-left');
    mkdirSync(path.join(leftover, 'node_modules'), { recursive: true });
    writeFileSync(path.join(leftover, 'node_modules', 'x.js'), '');
    git(dir, 'checkout', '-q', 'main'); // git inside the leftover now answers "main"
    git(dir, 'checkout', '-q', 'dev');
    expect(isOwnWorktree(leftover)).toBe(false);

    const result = await cleanupWorktree({ worktreePath: leftover, projectPath: dir, specId: '002-left' });

    expect(existsSync(leftover)).toBe(false);
    expect(branches(dir)).toEqual(expect.arrayContaining(['main', 'dev']));
    expect(result.branch).toBe('vibe-teamlead/002-left');
  });
});

describe('makeTreeWritable', () => {
  it('gives the owner write access to a read-only tree like a pnpm store, leaving symlink targets alone', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-ro-'));
    const store = path.join(root, '.pnpm-store', 'v3', 'files', '00');
    mkdirSync(store, { recursive: true });
    const file = path.join(store, 'blob');
    writeFileSync(file, 'x');
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-out-')), 'target');
    writeFileSync(outside, 'y');
    chmodSync(outside, 0o444);
    symlinkSync(outside, path.join(store, 'link'));
    chmodSync(file, 0o444);
    for (const d of [store, path.dirname(store), path.join(root, '.pnpm-store', 'v3'), path.join(root, '.pnpm-store')]) chmodSync(d, 0o555);

    await makeTreeWritable(root);

    const mode = (p: string) => lstatSync(p).mode & 0o777;
    expect(mode(path.join(root, '.pnpm-store'))).toBe(0o755);
    expect(mode(store)).toBe(0o755);
    expect(mode(file)).toBe(0o644);
    expect(mode(outside)).toBe(0o444);
  });
});
