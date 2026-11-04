import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeTaskBranch } from '../git-merge';

const BINARY = Buffer.from([0x00, 0x01, 0xa8, 0x10, 0xff, 0xfe, 0x00, 0x80]);
const BRANCH = 'vibe-teamlead/001-task';

describe('mergeTaskBranch', () => {
  let repo: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const commitAll = (cwd: string, message: string) => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
  };
  const merge = (over: Partial<Parameters<typeof mergeTaskBranch>[0]> = {}) =>
    mergeTaskBranch({
      projectDir: repo,
      branch: BRANCH,
      baseBranch: 'main',
      worktreePath: wt,
      message: 'Merge the task',
      stageOnly: false,
      resolveConflicts: async () => new Map(),
      ...over,
    });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-merge-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'shared.txt'), 'one\n');
    writeFileSync(join(repo, 'gone.txt'), 'delete me\n');
    commitAll(repo, 'first');
    wt = join(repo, '.vibe-teamlead', 'worktrees', 'tasks', '001-task');
    git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
    mkdirSync(join(wt, 'public'));
    writeFileSync(join(wt, 'public', 'favicon.ico'), BINARY);
    writeFileSync(join(wt, 'public', '.gitkeep'), '');
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    rmSync(join(wt, 'gone.txt'));
    commitAll(wt, 'task one');
    writeFileSync(join(wt, 'new.txt'), 'newer\n');
    commitAll(wt, 'task two');
  });

  it('creates a real merge commit with the whole history, and every kind of file intact', async () => {
    const before = head();
    const tip = git(repo, 'rev-parse', BRANCH);

    await expect(merge()).resolves.toMatchObject({ status: 'merged' });

    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([before, tip]);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge the task');
    expect(git(repo, 'log', '--format=%s')).toContain('task one');
    expect(readFileSync(join(repo, 'public', 'favicon.ico')).equals(BINARY)).toBe(true);
    expect(existsSync(join(repo, 'public', '.gitkeep'))).toBe(true);
    expect(existsSync(join(repo, 'gone.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('newer\n');
  });

  it("leaves the user's other files out of the commit", async () => {
    mkdirSync(join(repo, '.vibe-teamlead', 'specs'), { recursive: true });
    writeFileSync(join(repo, '.vibe-teamlead', 'specs', 'plan.json'), '{}');
    writeFileSync(join(repo, 'notes.txt'), 'mine\n');
    writeFileSync(join(repo, 'shared.txt'), 'unfinished\n');

    await expect(merge()).resolves.toMatchObject({ status: 'merged' });

    const committed = git(repo, 'diff', '--name-only', 'HEAD^1', 'HEAD');
    expect(committed).not.toMatch(/\.vibe-teamlead|notes\.txt|shared\.txt/);
    expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('unfinished\n');
    expect(existsSync(join(repo, 'notes.txt'))).toBe(true);
  });

  it("takes in the worktree's uncommitted edits to tracked files, not its stray files", async () => {
    writeFileSync(join(wt, 'new.txt'), 'edited after the last commit\n');
    writeFileSync(join(wt, 'stray.mjs'), 'left by QA\n');

    await expect(merge()).resolves.toMatchObject({ status: 'merged' });

    expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('edited after the last commit\n');
    expect(existsSync(join(repo, 'stray.mjs'))).toBe(false);
  });

  describe('refuses and changes nothing', () => {
    it('on another branch', async () => {
      git(repo, 'checkout', '-q', '-b', 'other');
      const before = head();
      const result = await merge();
      expect(result.status).toBe('refused');
      expect(result.message).toMatch(/main/);
      expect(head()).toBe(before);
    });

    it('when the task branch does not exist', async () => {
      await expect(merge({ branch: 'vibe-teamlead/nope', worktreePath: undefined })).resolves.toMatchObject({ status: 'refused' });
    });

    it("when the user's staged work is in the way", async () => {
      writeFileSync(join(repo, 'staged.txt'), 'mine\n');
      git(repo, 'add', 'staged.txt');
      const before = head();
      await expect(merge()).resolves.toMatchObject({ status: 'refused' });
      expect(head()).toBe(before);
      expect(git(repo, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    });

    it('when the merge would overwrite an uncommitted file', async () => {
      writeFileSync(join(repo, 'new.txt'), 'my own new file\n');
      const before = head();
      await expect(merge()).resolves.toMatchObject({ status: 'refused' });
      expect(head()).toBe(before);
      expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('my own new file\n');
    });

    it("when the project's commit hook rejects it, with the hook's words", async () => {
      const hook = join(repo, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      const before = head();
      const result = await merge();
      expect(result.status).toBe('refused');
      expect(result.message).toContain('lint failed');
      expect(head()).toBe(before);
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    });
  });

  describe('conflicts', () => {
    beforeEach(() => {
      writeFileSync(join(repo, 'shared.txt'), 'main side\n');
      git(repo, 'commit', '-q', '-am', 'main moved');
      writeFileSync(join(wt, 'shared.txt'), 'task side\n');
      commitAll(wt, 'task touched shared');
    });

    it('sends only the conflicted files to the resolver and commits the result', async () => {
      const resolveConflicts = vi.fn(async () => new Map([['shared.txt', 'both sides\n']]));
      const before = head();

      await expect(merge({ resolveConflicts })).resolves.toMatchObject({ status: 'merged' });

      expect(resolveConflicts).toHaveBeenCalledWith(['shared.txt']);
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('both sides\n');
      expect(readFileSync(join(repo, 'public', 'favicon.ico')).equals(BINARY)).toBe(true);
      expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
      expect(git(repo, 'rev-parse', 'HEAD^1')).toBe(before);
    });

    it.each([
      ['nothing back', new Map<string, string>()],
      ['conflict markers', new Map([['shared.txt', '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> task\n']])],
      ['damaged binary text', new Map([['shared.txt', 'a�b']])],
      ['an empty file', new Map([['shared.txt', '']])],
    ])('rolls back and names the file when the resolver gives %s', async (_name, resolved) => {
      const before = head();
      const result = await merge({ resolveConflicts: async () => resolved });
      expect(result).toMatchObject({ status: 'conflicts', conflictFiles: ['shared.txt'] });
      expect(head()).toBe(before);
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('main side\n');
    });

    it('rolls back when the resolver fails', async () => {
      const result = await merge({ resolveConflicts: async () => { throw new Error('no model'); } });
      expect(result.status).toBe('conflicts');
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    });

    it('stage only: rolls back cleanly too', async () => {
      const result = await merge({ stageOnly: true });
      expect(result.status).toBe('conflicts');
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(existsSync(join(repo, '.git', 'SQUASH_MSG'))).toBe(false);
    });
  });

  it('stage only: staged in full and uncommitted, the branch untouched', async () => {
    const before = head();
    await expect(merge({ stageOnly: true })).resolves.toMatchObject({ status: 'staged' });
    expect(head()).toBe(before);
    expect(git(repo, 'diff', '--cached', '--name-only')).toContain('public/favicon.ico');
    expect(readFileSync(join(repo, 'public', 'favicon.ico')).equals(BINARY)).toBe(true);
    expect(git(repo, 'rev-parse', '--verify', BRANCH)).toBeTruthy();
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('says so when the branch is already merged', async () => {
    await merge();
    const after = head();
    await expect(merge()).resolves.toMatchObject({ status: 'up_to_date' });
    expect(head()).toBe(after);
  });

  it('accepts a base branch given as origin/main', async () => {
    await expect(merge({ baseBranch: 'origin/main' })).resolves.toMatchObject({ status: 'merged' });
  });
});
