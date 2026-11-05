import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listCommittedFiles, parsePorcelainZ, readOnlyGitArgs, reviewerChangedFiles, takeWorkTreeSnapshot, type WorkTreeSnapshot } from '../reviewer-changes';

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

  it('merges the files of a commit the reviewer made, once each and without the spec directory', () => {
    const before = snap('h1', { 'src/app.ts': 'a1' });
    const after = snap('h2', { 'src/app.ts': 'a2' });
    const committed = ['src/app.ts', 'src/committed.ts', '.vibe-teamlead/specs/001/qa_report.md'];
    expect(reviewerChangedFiles(before, after, dirs, committed)).toEqual({ files: ['src/app.ts', 'src/committed.ts'], headMoved: true });
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

  it.skipIf(process.platform === 'win32')('records a FIFO by its mode without reading it, which would block forever', async () => {
    // git lists no untracked FIFO, but a tracked file replaced by one shows as modified
    const repo = initRepo();
    rmSync(join(repo, 'src', 'a.ts'));
    execFileSync('mkfifo', [join(repo, 'src', 'a.ts')]);
    const result = await Promise.race([
      takeWorkTreeSnapshot(repo),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('snapshot blocked on the FIFO')), 10_000)),
    ]);
    if ('error' in result) throw new Error(result.error);
    expect(result.files['src/a.ts']).toMatch(/^special:\d+$/);
  });

  it('fails instead of ignoring a directory entry (a nested repository or submodule)', async () => {
    const repo = initRepo();
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: nested, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(nested, 'x.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'nested');
    expect(await takeWorkTreeSnapshot(repo)).toEqual({ error: 'submodule or directory entry: nested/' });
  });

  it('snapshots a file map without inherited properties', async () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'constructor'), 'x');
    const result = await takeWorkTreeSnapshot(repo);
    if ('error' in result) throw new Error(result.error);
    expect(Object.getPrototypeOf(result.files)).toBeNull();
    expect(result.files.constructor).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('listCommittedFiles', () => {
  it('lists the files a commit range touched, so a reviewer commit does not hide them', async () => {
    const repo = initRepo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
    const from = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'two');
    writeFileSync(join(repo, 'src', 'c.ts'), 'new');
    git('add', '.');
    git('commit', '-q', '-m', 'reviewer');
    const to = git('rev-parse', 'HEAD');
    expect((await listCommittedFiles(repo, from, to))?.sort()).toEqual(['src/a.ts', 'src/c.ts']);
    expect(await listCommittedFiles(repo, from, 'not-a-commit')).toBeUndefined();
  });
});

/** A repository with one commit holding src/a.ts. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'vtl-snap-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'one');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return repo;
}
