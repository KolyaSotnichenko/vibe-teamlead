import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { cleanUpPreviewLeftovers, previewSpecDir, previewWorktreePath, syncPreviewWorktree } from '../preview-worktree';

const at = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'preview-root-'))), '.vibe-teamlead', 'worktrees', 'preview', 'p1');

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
    const wt = at();
    const result = await syncPreviewWorktree(dir, 'main', 'git', wt);
    expect(result.path).toBe(wt);
    expect(result.moved).toBe(true);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.path, encoding: 'utf-8' }).trim()).toBe(git('rev-parse', 'main'));
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: result.path, encoding: 'utf-8' }).trim()).toBe('');
    expect(result.lockfileChanged).toBe(true);
  });

  it("moves to main's new commit and reports a changed lockfile", async () => {
    const { dir, git, commit } = repo();
    const wt = at();
    await syncPreviewWorktree(dir, 'main', 'git', wt);
    commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const result = await syncPreviewWorktree(dir, 'main', 'git', wt);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.path, encoding: 'utf-8' }).trim()).toBe(git('rev-parse', 'main'));
    expect(result.lockfileChanged).toBe(true);
  });

  it('reports no lockfile change when only source changed', async () => {
    const { dir, commit } = repo();
    const wt = at();
    await syncPreviewWorktree(dir, 'main', 'git', wt);
    commit('page.tsx');
    const again = await syncPreviewWorktree(dir, 'main', 'git', wt);
    expect(again.lockfileChanged).toBe(false);
    expect(again.moved).toBe(true);
    expect((await syncPreviewWorktree(dir, 'main', 'git', wt)).moved).toBe(false);
  });

  it("leaves the owner's checkout untouched", async () => {
    const { dir, git, commit } = repo();
    const wt = at();
    commit('a.txt');
    git('checkout', '-q', '-b', 'mine');
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    const before = [git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')];
    await syncPreviewWorktree(dir, 'main', 'git', wt);
    await syncPreviewWorktree(dir, 'main', 'git', wt);
    expect([git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')]).toEqual(before);
  });

  it('lives outside the project, one per project', () => {
    expect(previewWorktreePath('/home/u/.vibe-teamlead/worktrees/preview', 'p/1')).toBe('/home/u/.vibe-teamlead/worktrees/preview/p_1');
  });

  it('keeps its state under the worktree, where leftover servers are found', () => {
    expect(previewSpecDir('/p/.vibe-teamlead/worktrees/preview')).toBe('/p/.vibe-teamlead/worktrees/preview/.vibe-teamlead/specs/preview');
  });

  it('at app start, cleans up the leftover servers of every preview worktree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-root-')));
    mkdirSync(join(root, 'p1'));
    mkdirSync(join(root, 'p2'));
    const cleanUp = vi.fn();
    cleanUpPreviewLeftovers(root, cleanUp);
    expect(cleanUp.mock.calls.map(([dir]) => dir).sort()).toEqual([previewSpecDir(join(root, 'p1')), previewSpecDir(join(root, 'p2'))]);
    cleanUpPreviewLeftovers(join(root, 'missing'), cleanUp);
  });
});

