import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { previewSpecDir, previewWorktreePath, syncPreviewWorktree } from '../preview-worktree';

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'preview-wt-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const commit = (file: string, text = 'x\n') => {
    writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', file);
  };
  commit('.gitignore', '.vibe-teamlead/\n');
  return { dir, git, commit };
}

describe('the preview worktree', () => {
  it('creates a detached worktree at main', async () => {
    const { dir, git } = repo();
    const result = await syncPreviewWorktree(dir, 'main', 'git');
    expect(result.path).toBe(previewWorktreePath(dir));
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.path, encoding: 'utf-8' }).trim()).toBe(git('rev-parse', 'main'));
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: result.path, encoding: 'utf-8' }).trim()).toBe('');
    expect(result.lockfileChanged).toBe(true);
  });

  it("moves to main's new commit and reports a changed lockfile", async () => {
    const { dir, git, commit } = repo();
    await syncPreviewWorktree(dir, 'main', 'git');
    commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const result = await syncPreviewWorktree(dir, 'main', 'git');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.path, encoding: 'utf-8' }).trim()).toBe(git('rev-parse', 'main'));
    expect(result.lockfileChanged).toBe(true);
  });

  it('reports no lockfile change when only source changed', async () => {
    const { dir, commit } = repo();
    await syncPreviewWorktree(dir, 'main', 'git');
    commit('page.tsx');
    expect((await syncPreviewWorktree(dir, 'main', 'git')).lockfileChanged).toBe(false);
  });

  it("leaves the owner's checkout untouched", async () => {
    const { dir, git, commit } = repo();
    commit('a.txt');
    git('checkout', '-q', '-b', 'mine');
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    const before = [git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')];
    await syncPreviewWorktree(dir, 'main', 'git');
    await syncPreviewWorktree(dir, 'main', 'git');
    expect([git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')]).toEqual(before);
  });

  it('keeps its state under the worktree, where leftover servers are found', () => {
    expect(previewSpecDir('/p/.vibe-teamlead/worktrees/preview')).toBe('/p/.vibe-teamlead/worktrees/preview/.vibe-teamlead/specs/preview');
  });
});
