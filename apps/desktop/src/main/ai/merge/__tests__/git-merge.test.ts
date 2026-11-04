import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelMergeReview, commitMergeReview, getMergeReview, getMergeReviewDiff, mergeTaskBranch, withoutGitHooks } from '../git-merge';

const BINARY = Buffer.from([0x00, 0x01, 0xa8, 0x10, 0xff, 0xfe, 0x00, 0x80]);
const BRANCH = 'vibe-teamlead/001-task';
const ALL_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'reference-transaction', 'post-index-change', 'post-checkout', 'post-rewrite'];

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
      resolveConflict: async () => undefined,
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

  });

  it('runs no hooks: a branch could bring its own, and they would run outside the agents\' limits', async () => {
    const marker = join(repo, 'hook-ran');
    mkdirSync(join(wt, 'hooks'));
    for (const name of ALL_HOOKS) {
      writeFileSync(join(wt, 'hooks', name), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
      chmodSync(join(wt, 'hooks', name), 0o755);
    }
    commitAll(wt, 'task brings hooks');
    git(repo, 'config', 'core.hooksPath', 'hooks');

    await expect(merge()).resolves.toMatchObject({ status: 'merged' });

    expect(existsSync(marker)).toBe(false);
  });

  describe('conflicts', () => {
    beforeEach(() => {
      writeFileSync(join(repo, 'shared.txt'), 'main side\n');
      git(repo, 'commit', '-q', '-am', 'main moved');
      writeFileSync(join(wt, 'shared.txt'), 'task side\n');
      commitAll(wt, 'task touched shared');
    });

    it('gives the resolver all three versions, only for the conflicted file', async () => {
      const resolveConflict = vi.fn(async () => 'both sides');
      await merge({ resolveConflict });
      expect(resolveConflict.mock.calls).toEqual([[{ file: 'shared.txt', base: 'one\n', ours: 'main side\n', theirs: 'task side\n' }]]);
    });

    describe("the model's merge waits for the user", () => {
      const options = () => ({ projectDir: repo, branch: BRANCH, message: 'Merge the task' });
      const resolved = () => merge({ resolveConflict: async () => 'both sides' });

      it('no commit yet: the result is staged and the merge stays open', async () => {
        const before = head();
        await expect(resolved()).resolves.toMatchObject({ status: 'needs_review', conflictFiles: ['shared.txt'] });
        expect(head()).toBe(before);
        // The model trims its answer; the file keeps its last line's newline
        expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('both sides\n');
        expect(git(repo, 'diff', '--cached', '--name-only')).toContain('shared.txt');
        expect(git(repo, 'rev-parse', '--verify', BRANCH)).toBeTruthy();
        await expect(getMergeReview(options())).resolves.toEqual({ files: ['shared.txt'] });
      });

      it('confirming makes the merge commit, naming the files, and takes in the user\'s edits', async () => {
        const before = head();
        await resolved();
        writeFileSync(join(repo, 'shared.txt'), 'corrected by hand\n');

        await expect(commitMergeReview(options())).resolves.toMatchObject({ status: 'merged' });

        expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
        expect(git(repo, 'rev-parse', 'HEAD^1')).toBe(before);
        expect(git(repo, 'show', 'HEAD:shared.txt')).toBe('corrected by hand');
        expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge the task');
        expect(git(repo, 'log', '-1', '--format=%b')).toBe('Conflicts resolved by the model, then confirmed:\n- shared.txt');
        await expect(getMergeReview(options())).resolves.toBeNull();
      });

      it('cancelling puts the project back', async () => {
        const before = head();
        await resolved();

        await expect(cancelMergeReview(options())).resolves.toMatchObject({ status: 'cancelled' });

        expect(head()).toBe(before);
        expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('main side\n');
        expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
        await expect(getMergeReview(options())).resolves.toBeNull();
      });

      it('nothing to review once the merge was finished or dropped in a terminal', async () => {
        await resolved();
        git(repo, 'merge', '--abort');
        await expect(getMergeReview(options())).resolves.toBeNull();
        await expect(commitMergeReview(options())).resolves.toMatchObject({ status: 'refused' });
        await expect(cancelMergeReview(options())).resolves.toMatchObject({ status: 'refused' });
      });

      it("another merge in progress isn't this task's, so it is neither committed nor dropped", async () => {
        await resolved();
        git(repo, 'merge', '--abort');
        git(repo, 'checkout', '-q', '-b', 'other', 'HEAD~1');
        writeFileSync(join(repo, 'shared.txt'), 'other\n');
        git(repo, 'commit', '-q', '-am', 'other');
        git(repo, 'checkout', '-q', 'main');
        expect(() => git(repo, 'merge', 'other')).toThrow();

        await expect(getMergeReview(options())).resolves.toBeNull();
        await expect(cancelMergeReview(options())).resolves.toMatchObject({ status: 'refused' });
        expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
      });

      it('shows what the merge changes in the project, and how it differs from the task', async () => {
        await resolved();
        const project = await getMergeReviewDiff({ ...options(), file: 'shared.txt', against: 'project' });
        expect(project?.diff).toContain('-main side');
        expect(project?.diff).toContain('+both sides');
        expect(project?.truncated).toBe(false);
        const task = await getMergeReviewDiff({ ...options(), file: 'shared.txt', against: 'task' });
        expect(task?.diff).toContain('-task side');
        expect(task?.diff).toContain('+both sides');
      });

      it("shows the text even when the branch's .gitattributes calls the file binary", async () => {
        writeFileSync(join(wt, '.gitattributes'), 'shared.txt -diff\n');
        commitAll(wt, 'task hides the file from diffs');
        await resolved();
        const result = await getMergeReviewDiff({ ...options(), file: 'shared.txt', against: 'project' });
        expect(result?.diff).toContain('+both sides');
      });

      it("the diff follows the user's edits", async () => {
        await resolved();
        writeFileSync(join(repo, 'shared.txt'), 'corrected by hand\n');
        const { diff } = (await getMergeReviewDiff({ ...options(), file: 'shared.txt', against: 'project' })) ?? { diff: '' };
        expect(diff).toContain('+corrected by hand');
      });

      it('gives no diff for a file outside the review, or without a review', async () => {
        await expect(getMergeReviewDiff({ ...options(), file: 'shared.txt', against: 'project' })).resolves.toBeNull();
        await resolved();
        await expect(getMergeReviewDiff({ ...options(), file: 'gone.txt', against: 'project' })).resolves.toBeNull();
        await expect(getMergeReviewDiff({ ...options(), file: '../../etc/passwd', against: 'project' })).resolves.toBeNull();
      });

      it('cuts a huge diff and says so', async () => {
        await merge({ resolveConflict: async () => `${'line of text\n'.repeat(60_000)}` });
        const result = await getMergeReviewDiff({ ...options(), file: 'shared.txt', against: 'project' });
        expect(result?.truncated).toBe(true);
        expect(result?.diff.length).toBeLessThanOrEqual(256 * 1024);
      });

      it('stage only stays as it was: staged, for the user to commit', async () => {
        await expect(merge({ stageOnly: true, resolveConflict: async () => 'both sides' })).resolves.toMatchObject({ status: 'staged' });
        await expect(getMergeReview(options())).resolves.toBeNull();
      });
    });

    it.each([
      ['nothing back', undefined],
      ['conflict markers', '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> task\n'],
      ['damaged binary text', 'a\uFFFDb'],
      ['an empty file', ''],
      ['the file wrapped in a code fence', '```\nboth\n```'],
    ])('rolls back and names the file when the resolver gives %s', async (_name, resolved) => {
      const before = head();
      const result = await merge({ resolveConflict: async () => resolved });
      expect(result).toMatchObject({ status: 'conflicts', conflictFiles: ['shared.txt'] });
      expect(head()).toBe(before);
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('main side\n');
    });

    it('runs no hooks on a rollback either', async () => {
      const marker = join(repo, 'hook-ran');
      mkdirSync(join(repo, '.git', 'tracked-hooks'));
      for (const name of ALL_HOOKS) {
        writeFileSync(join(repo, '.git', 'tracked-hooks', name), `#!/bin/sh\ntouch "${marker}"\n`);
        chmodSync(join(repo, '.git', 'tracked-hooks', name), 0o755);
      }
      git(repo, 'config', 'core.hooksPath', '.git/tracked-hooks');
      await expect(merge()).resolves.toMatchObject({ status: 'conflicts' });
      expect(existsSync(marker)).toBe(false);
    });

    it('rolls back when the resolver fails', async () => {
      const result = await merge({ resolveConflict: async () => { throw new Error('no model'); } });
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

  describe('conflicts the resolver must never see', () => {
    const resolveConflict = vi.fn(async () => 'anything');
    beforeEach(() => resolveConflict.mockClear());

    const conflictWith = (file: string, mainSide: () => void, taskSide?: () => void) => {
      mainSide();
      git(repo, 'add', '--', file);
      git(repo, 'commit', '-q', '-m', 'main side');
      if (taskSide) {
        taskSide();
        commitAll(wt, 'task side');
      }
    };

    it('a symlink: a write through it could land outside the project', async () => {
      const outside = join(mkdtempSync(join(tmpdir(), 'vtl-outside-')), 'secret');
      writeFileSync(outside, 'untouched');
      conflictWith('link', () => symlinkSync('shared.txt', join(repo, 'link')), () => symlinkSync(outside, join(wt, 'link')));

      await expect(merge({ resolveConflict })).resolves.toMatchObject({ status: 'conflicts', conflictFiles: ['link'] });

      expect(resolveConflict).not.toHaveBeenCalled();
      expect(readFileSync(outside, 'utf-8')).toBe('untouched');
    });

    it('writes to the conflicted file itself when its name holds a tab', async () => {
      const name = 'a\tb.txt';
      writeFileSync(join(repo, 'a'), 'must stay\n');
      git(repo, 'add', 'a');
      conflictWith(name, () => writeFileSync(join(repo, name), 'main\n'), () => writeFileSync(join(wt, name), 'task\n'));

      await expect(merge({ resolveConflict })).resolves.toMatchObject({ status: 'needs_review' });

      expect(readFileSync(join(repo, 'a'), 'utf-8')).toBe('must stay\n');
      expect(readFileSync(join(repo, name), 'utf-8')).toBe('anything\n');
    });

    it('a binary file', async () => {
      conflictWith('logo.png', () => writeFileSync(join(repo, 'logo.png'), Buffer.from([0, 1, 2])), () => writeFileSync(join(wt, 'logo.png'), Buffer.from([0, 3, 4])));
      await expect(merge({ resolveConflict })).resolves.toMatchObject({ status: 'conflicts', conflictFiles: ['logo.png'] });
      expect(resolveConflict).not.toHaveBeenCalled();
    });

    it('a file one side deleted', async () => {
      conflictWith('gone.txt', () => writeFileSync(join(repo, 'gone.txt'), 'main keeps and edits\n'));
      await expect(merge({ resolveConflict })).resolves.toMatchObject({ status: 'conflicts', conflictFiles: ['gone.txt'] });
      expect(resolveConflict).not.toHaveBeenCalled();
      expect(readFileSync(join(repo, 'gone.txt'), 'utf-8')).toBe('main keeps and edits\n');
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

  it('adds to git config passed through the environment, not over it', () => {
    expect(withoutGitHooks({ GIT_CONFIG_COUNT: '2' })).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath' });
    expect(withoutGitHooks({})).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath' });
  });

  it('accepts a base branch given as origin/main', async () => {
    await expect(merge({ baseBranch: 'origin/main' })).resolves.toMatchObject({ status: 'merged' });
  });
});
