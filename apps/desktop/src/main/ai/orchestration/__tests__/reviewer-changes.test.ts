import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePorcelainZ, readOnlyGitArgs, reviewerChangedFiles, takeWorkTreeSnapshot, type WorkTreeSnapshot } from '../reviewer-changes';

const dirs = { projectDir: '/p', specDir: '/p/.vibe-teamlead/specs/001' };
const snap = (head: string, files: Record<string, string>): WorkTreeSnapshot => ({ head, files });

describe('reviewerChangedFiles', () => {
  it('catches a file whose content changed although its status letters did not', () => {
    const before = snap('h1', { 'src/app.ts': 'sha-a', 'src/same.ts': 'sha-s' });
    const after = snap('h1', { 'src/app.ts': 'sha-b', 'src/same.ts': 'sha-s' });
    expect(reviewerChangedFiles(before, after, dirs)).toEqual({ files: ['src/app.ts'], headMoved: false });
  });

  it('lists files that appear, disappear or get deleted, and both sides of a rename', () => {
    const before = snap('h1', { 'src/old.ts': 'sha-1', 'src/gone.ts': 'sha-g' });
    const after = snap('h1', { 'src/new.ts': 'sha-1', 'src/old.ts': 'deleted', 'src/fresh.ts': 'sha-f' });
    expect(reviewerChangedFiles(before, after, dirs).files.sort()).toEqual(['src/fresh.ts', 'src/gone.ts', 'src/new.ts', 'src/old.ts']);
  });

  it('leaves out the spec directory and the root .vibe-teamlead folder only', () => {
    const before = snap('h1', {});
    const after = snap('h1', {
      '.vibe-teamlead/specs/001/qa_report.md': 'x',
      '.vibe-teamlead/task_logs/t.json': 'x',
      'packages/a/.vibe-teamlead/config.json': 'x',
      'src/app.ts': 'x',
    });
    expect(reviewerChangedFiles(before, after, dirs).files).toEqual(['packages/a/.vibe-teamlead/config.json', 'src/app.ts']);
  });

  it('notes when HEAD moved: the reviewer made a commit', () => {
    expect(reviewerChangedFiles(snap('h1', {}), snap('h2', {}), dirs)).toEqual({ files: [], headMoved: true });
  });
});

describe('parsePorcelainZ', () => {
  it('splits on NUL and takes both paths of a rename', () => {
    const out = ' M src/a.ts\0?? src/b.ts\0R  src/new.ts\0src/old.ts\0D  src/c.ts\0';
    expect(parsePorcelainZ(out)).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/old.ts', 'src/c.ts']);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('readOnlyGitArgs', () => {
  it('turns off the file system monitor, the untracked cache, hooks and optional locks', () => {
    expect(readOnlyGitArgs(['status', '--porcelain'])).toEqual([
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', expect.stringMatching(/^core\.hooksPath=/), '--no-optional-locks', 'status', '--porcelain',
    ]);
  });
});

describe('takeWorkTreeSnapshot', () => {
  it('hashes the working-tree content of every changed path and fails closed outside a repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vtl-snap-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'one');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'src', 'a.ts'), 'two');
    const first = await takeWorkTreeSnapshot(repo);
    expect('error' in first).toBe(false);
    writeFileSync(join(repo, 'src', 'a.ts'), 'three');
    writeFileSync(join(repo, 'src', 'b.ts'), 'new');
    const second = await takeWorkTreeSnapshot(repo);
    if ('error' in first || 'error' in second) throw new Error('snapshot failed');
    expect(first.head).toBe(second.head);
    expect(reviewerChangedFiles(first, second, { projectDir: repo, specDir: join(repo, '.vibe-teamlead/specs/001') }).files.sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const outside = mkdtempSync(join(tmpdir(), 'vtl-norepo-'));
    expect(await takeWorkTreeSnapshot(outside)).toMatchObject({ error: expect.any(String) });
  });
});
