import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeTaskBranch, withoutGitHooks } from '../git-merge';

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

  describe("the worktree's uncommitted edits", () => {
    beforeEach(() => {
      writeFileSync(join(wt, 'new.txt'), 'edited after the last commit\n');
    });

    it('are part of the task when QA approved them, stray files are not', async () => {
      writeFileSync(join(wt, 'stray.mjs'), 'left by QA\n');

      await expect(merge({ uncommittedApproved: async () => true })).resolves.toMatchObject({ status: 'merged' });

      expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('edited after the last commit\n');
      expect(existsSync(join(repo, 'stray.mjs'))).toBe(false);
    });

    it.each([
      ['QA never saw them', async () => false],
      ['nobody could say', undefined],
    ])('stop the merge when %s, and name the files', async (_name, uncommittedApproved) => {
      const before = head();
      const tip = git(repo, 'rev-parse', BRANCH);

      const result = await merge({ uncommittedApproved });

      expect(result.status).toBe('refused');
      expect(result.message).toContain('new.txt');
      expect(head()).toBe(before);
      expect(git(repo, 'rev-parse', BRANCH)).toBe(tip);
      expect(readFileSync(join(wt, 'new.txt'), 'utf-8')).toBe('edited after the last commit\n');
    });

    it('do not ask anything when there are none', async () => {
      git(wt, 'checkout', '--', 'new.txt');
      const uncommittedApproved = vi.fn(async () => false);
      await expect(merge({ uncommittedApproved })).resolves.toMatchObject({ status: 'merged' });
      expect(uncommittedApproved).not.toHaveBeenCalled();
    });
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

  describe('conflicts: the project branch moved after the task integrated with it', () => {
    beforeEach(() => {
      writeFileSync(join(repo, 'shared.txt'), 'main side\n');
      git(repo, 'commit', '-q', '-am', 'main moved');
      writeFileSync(join(wt, 'shared.txt'), 'task side\n');
      commitAll(wt, 'task touched shared');
    });

    it('puts the project back, names the files and says what happened', async () => {
      const before = head();
      const result = await merge();
      expect(result).toMatchObject({ status: 'conflicts', conflictFiles: ['shared.txt'] });
      expect(result.message).toMatch(/"main" changed/);
      expect(head()).toBe(before);
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('main side\n');
    });

    describe('when the merge has to be undone', () => {
      const lock = () => join(repo, '.git', 'index.lock');
      const merging = () => existsSync(join(repo, '.git', 'MERGE_HEAD'));
      /** git, but something else takes the index right after the merge stops */
      const gitWithLock = (release: string) => {
        const script = join(mkdtempSync(join(tmpdir(), 'vtl-git-')), 'git');
        writeFileSync(script, `#!/bin/sh\ngit "$@"; rc=$?\ncase " $* " in *" merge --no-commit "*) touch "${lock()}"; ${release};; esac\nexit $rc\n`);
        chmodSync(script, 0o755);
        return script;
      };

      it('does not say nothing changed when git could not undo it', async () => {
        const result = await merge({ git: gitWithLock(':') });
        expect(merging()).toBe(true);
        expect(result.status).toBe('refused');
        expect(result.message).toMatch(/git reset --merge/);
      });

      it('waits out a moment when something else holds the index', async () => {
        const result = await merge({ git: gitWithLock(`(sleep 0.15; rm -f "${lock()}") &`) });
        expect(result).toMatchObject({ status: 'conflicts', conflictFiles: ['shared.txt'] });
        expect(merging()).toBe(false);
        expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      });
    });

    describe('a merge that is already open', () => {
      beforeEach(() => {
        git(repo, 'checkout', '-q', '-b', 'mine', 'HEAD~1');
        writeFileSync(join(repo, 'shared.txt'), 'my side\n');
        git(repo, 'commit', '-q', '-am', 'my change');
        git(repo, 'checkout', '-q', 'main');
        try {
          git(repo, 'merge', '--no-commit', 'mine');
        } catch {
          // Stops on the conflict: this merge is the user's to finish
        }
      });

      it("is left alone: it isn't undone", async () => {
        const mine = git(repo, 'rev-parse', 'mine');
        const result = await merge();
        expect(result.status).toBe('refused');
        expect(git(repo, 'rev-parse', 'MERGE_HEAD')).toBe(mine);
        expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
      });
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

  it('adds to git config passed through the environment, not over it', () => {
    expect(withoutGitHooks({ GIT_CONFIG_COUNT: '2' })).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath' });
    expect(withoutGitHooks({})).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath' });
  });

  it('accepts a base branch given as origin/main', async () => {
    await expect(merge({ baseBranch: 'origin/main' })).resolves.toMatchObject({ status: 'merged' });
  });
});
