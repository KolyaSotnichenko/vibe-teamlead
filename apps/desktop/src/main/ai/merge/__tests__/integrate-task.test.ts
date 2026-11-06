import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeTaskBranch } from '../git-merge';
import { inMergeQueue } from '../merge-queue';
import {
  AgentStillRunningError,
  cancelIntegrationReview,
  getIntegrationReview,
  getIntegrationReviewDiff,
  getMergeState,
  INTEGRATION_FILE,
  integrateAndMerge,
  integrateTask,
  type IntegrationAgentAnswer,
  type IntegrationAgentRequest,
  type IntegrateTaskOptions,
} from '../integrate-task';

const BRANCH = 'vibe-teamlead/001-task';
const OK: IntegrationAgentAnswer = { ok: true, summary: 'typecheck and tests pass' };

describe('integrateTask', () => {
  let repo: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commitAll = (cwd: string, message: string) => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
  };
  const tip = () => git(wt, 'rev-parse', 'HEAD');
  const main = () => git(repo, 'rev-parse', 'main');
  const has = (ancestor: string, of: string) => {
    try {
      git(repo, 'merge-base', '--is-ancestor', ancestor, of);
      return true;
    } catch {
      return false;
    }
  };
  const integrate = (runAgent: (request: IntegrationAgentRequest) => Promise<IntegrationAgentAnswer> = async () => OK) =>
    integrateTask({ worktreePath: wt, baseBranch: 'main', runAgent });
  const reviewOptions = () => ({ worktreePath: wt });
  /** Both sides change the same line, as two tasks running at once do */
  const conflict = () => {
    writeFileSync(join(repo, 'shared.txt'), 'main side\n');
    git(repo, 'commit', '-q', '-am', 'another task merged');
    writeFileSync(join(wt, 'shared.txt'), 'task side\n');
    commitAll(wt, 'task touched shared');
  };
  /** Main moved, in a file the task never touched */
  const mainMovedElsewhere = () => {
    writeFileSync(join(repo, 'other.txt'), 'from another task\n');
    commitAll(repo, 'another task merged');
  };
  const resolving = async () => {
    writeFileSync(join(wt, 'shared.txt'), 'both sides\n');
    return OK;
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-integrate-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'shared.txt'), 'one\n');
    writeFileSync(join(repo, '.gitignore'), '.vibe-teamlead/\n');
    commitAll(repo, 'first');
    wt = join(repo, '.vibe-teamlead', 'worktrees', 'tasks', '001-task');
    git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
    writeFileSync(join(wt, 'task.txt'), 'task\n');
    commitAll(wt, 'task work');
  });

  it('does nothing, and asks no agent, when the task already has the latest main', async () => {
    const runAgent = vi.fn(async () => OK);
    const before = tip();
    await expect(integrate(runAgent)).resolves.toEqual({ status: 'up_to_date' });
    expect(runAgent).not.toHaveBeenCalled();
    expect(tip()).toBe(before);
  });

  describe('when main moved without conflicts', () => {
    beforeEach(mainMovedElsewhere);

    it('still has an agent check the result: code that merges cleanly can be broken', async () => {
      const runAgent = vi.fn(async () => OK);
      await expect(integrate(runAgent)).resolves.toEqual({ status: 'verified', summary: OK.summary });
      expect(runAgent).toHaveBeenCalledWith({ baseBranch: 'main', conflictFiles: [] });
      expect(has(main(), tip())).toBe(true);
    });

    it('a merge the agent left as it was waits for no one', async () => {
      await integrate();
      await expect(getIntegrationReview(reviewOptions())).resolves.toBeNull();
    });

    it('what the agent had to fix waits for the user, and only that is listed', async () => {
      const result = await integrate(async () => {
        writeFileSync(join(wt, 'task.txt'), 'fixed for the new main\n');
        return OK;
      });
      expect(result).toEqual({ status: 'needs_review', files: ['task.txt'], summary: OK.summary });
      expect(git(wt, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(git(wt, 'show', 'HEAD:task.txt')).toBe('fixed for the new main');
    });

    it("takes a new file the agent staged, and leaves the agent's stray files out", async () => {
      await integrate(async () => {
        writeFileSync(join(wt, 'needed.ts'), 'needed\n');
        git(wt, 'add', 'needed.ts');
        writeFileSync(join(wt, 'stray.log'), 'stray\n');
        return OK;
      });
      expect(git(wt, 'ls-files')).toContain('needed.ts');
      expect(git(wt, 'ls-files')).not.toContain('stray.log');
    });
  });

  describe('when there are conflicts', () => {
    beforeEach(conflict);

    it('works in the task folder: the project stays as it was throughout', async () => {
      const before = main();
      await integrate(async () => {
        expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
        expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
        return resolving();
      });
      expect(main()).toBe(before);
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('main side\n');
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    });

    it('tells the agent which files are in conflict', async () => {
      const runAgent = vi.fn(resolving);
      await integrate(runAgent);
      expect(runAgent).toHaveBeenCalledWith({ baseBranch: 'main', conflictFiles: ['shared.txt'] });
    });

    it('commits the result on the task and waits for the user', async () => {
      const result = await integrate(resolving);
      expect(result).toMatchObject({ status: 'needs_review', files: ['shared.txt'] });
      expect(has(main(), tip())).toBe(true);
      expect(git(wt, 'show', 'HEAD:shared.txt')).toBe('both sides');
      await expect(getIntegrationReview(reviewOptions())).resolves.toMatchObject({ files: ['shared.txt'], summary: OK.summary });
    });

    it('lists a file the agent fixed beyond the conflict', async () => {
      const result = await integrate(async () => {
        writeFileSync(join(wt, 'task.txt'), 'also fixed\n');
        return resolving();
      });
      expect(result).toMatchObject({ status: 'needs_review' });
      expect(result.status === 'needs_review' && result.files.sort()).toEqual(['shared.txt', 'task.txt']);
    });

    it('accepts an agent that made the commit itself', async () => {
      const result = await integrate(async () => {
        await resolving();
        commitAll(wt, 'resolved');
        return OK;
      });
      expect(result).toMatchObject({ status: 'needs_review', files: ['shared.txt'] });
      expect(has(main(), tip())).toBe(true);
    });

    it('leaves nothing to conflict when the task then merges into main', async () => {
      await integrate(resolving);
      const merged = await mergeTaskBranch({ projectDir: repo, branch: BRANCH, baseBranch: 'main', worktreePath: wt, message: 'Merge the task', stageOnly: false });
      expect(merged.status).toBe('merged');
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('both sides\n');
    });

    describe('and it fails', () => {
      const putBack = (before: string) => {
        expect(tip()).toBe(before);
        expect(existsSync(join(repo, '.git', 'worktrees', '001-task', 'MERGE_HEAD'))).toBe(false);
        expect(git(wt, 'status', '--porcelain', '--untracked-files=no')).toBe('');
        expect(readFileSync(join(wt, 'shared.txt'), 'utf-8')).toBe('task side\n');
      };

      it('puts the task back and gives the reason when the agent gives up', async () => {
        const before = tip();
        await expect(integrate(async () => ({ ok: false, summary: 'the two tasks disagree about who owns the route' })))
          .resolves.toEqual({ status: 'failed', message: 'the two tasks disagree about who owns the route' });
        putBack(before);
      });

      it('puts the task back and gives the reason when the agent call fails', async () => {
        const before = tip();
        await expect(integrate(async () => { throw new Error('API Error: 429 busy'); }))
          .resolves.toEqual({ status: 'failed', message: 'API Error: 429 busy' });
        putBack(before);
      });

      it('leaves the folder alone while the agent may still be running, then undoes all it did at the next try', async () => {
        const before = tip();
        const result = await integrate(async () => { throw new AgentStillRunningError('The agent did not stop.'); });
        expect(result).toEqual({ status: 'failed', message: 'The agent did not stop.' });
        expect(existsSync(join(repo, '.git', 'worktrees', '001-task', 'MERGE_HEAD'))).toBe(true);

        // It finishes late: its commit must not reach the project unread
        writeFileSync(join(wt, 'shared.txt'), 'written late\n');
        commitAll(wt, 'late commit');

        await expect(integrate(resolving)).resolves.toMatchObject({ status: 'needs_review' });
        expect(has(before, tip())).toBe(true);
        expect(git(wt, 'log', '--format=%s')).not.toContain('late commit');
      });

      it("doesn't take the agent's word when conflict markers are still in the file", async () => {
        const before = tip();
        const result = await integrate(async () => OK);
        expect(result.status).toBe('failed');
        expect(result.status === 'failed' && result.message).toMatch(/shared\.txt.*conflict markers/);
        putBack(before);
      });

      it("doesn't take the agent's word when it dropped the merge", async () => {
        const before = tip();
        const result = await integrate(async () => {
          git(wt, 'merge', '--abort');
          return OK;
        });
        expect(result.status).toBe('failed');
        putBack(before);
      });

      it("doesn't take the agent's word when it rewrote the task's history", async () => {
        const before = tip();
        const result = await integrate(async () => {
          git(wt, 'merge', '--abort');
          git(wt, 'reset', '-q', '--hard', 'main');
          return OK;
        });
        expect(result.status).toBe('failed');
        putBack(before);
      });

      it('names the problem when git could not undo it', async () => {
        const lock = join(repo, '.git', 'worktrees', '001-task', 'index.lock');
        const result = await integrate(async () => {
          writeFileSync(lock, '');
          return { ok: false, summary: 'gave up' };
        });
        expect(result.status).toBe('failed');
        expect(result.status === 'failed' && result.message).toMatch(/git reset --hard/);
      });
    });

    it('cuts a very long reason', async () => {
      const result = await integrate(async () => { throw new Error('x'.repeat(5000)); });
      expect(result.status === 'failed' && result.message.length).toBeLessThan(500);
    });
  });

  describe('integrateAndMerge', () => {
    const flow = (over: Partial<Parameters<typeof integrateAndMerge>[0]> = {}) => integrateAndMerge({
      projectDir: repo,
      branch: BRANCH,
      baseBranch: 'main',
      worktreePath: wt,
      message: 'Merge the task',
      stageOnly: false,
      confirmed: false,
      runAgent: resolving,
      ...over,
    });

    it('merges at once when the task already has the latest main', async () => {
      const runAgent = vi.fn(resolving);
      await expect(flow({ runAgent })).resolves.toMatchObject({ status: 'merged' });
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('merges without asking when the agent changed nothing', async () => {
      mainMovedElsewhere();
      await expect(flow({ runAgent: async () => OK })).resolves.toMatchObject({ status: 'merged' });
      expect(readFileSync(join(repo, 'task.txt'), 'utf-8')).toBe('task\n');
    });

    it('stops for the user when the agent changed code: nothing reaches the project', async () => {
      conflict();
      const before = main();
      await expect(flow()).resolves.toMatchObject({ status: 'needs_review', files: ['shared.txt'] });
      expect(main()).toBe(before);
    });

    it("the plain merge can't go around a review", async () => {
      conflict();
      await flow();
      const before = main();
      await expect(flow()).resolves.toMatchObject({ status: 'needs_review', files: ['shared.txt'] });
      expect(main()).toBe(before);
    });

    it("confirming merges, with the user's edits", async () => {
      conflict();
      await flow();
      writeFileSync(join(wt, 'shared.txt'), 'corrected by hand\n');
      await expect(flow({ confirmed: true })).resolves.toMatchObject({ status: 'merged' });
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('corrected by hand\n');
    });

    it('confirming too late starts over: main moved, so the check has to be done again', async () => {
      conflict();
      await flow();
      mainMovedElsewhere();
      const runAgent = vi.fn(async () => OK);
      await expect(flow({ confirmed: true, runAgent })).resolves.toMatchObject({ status: 'merged' });
      expect(runAgent).toHaveBeenCalled();
    });

    it('reports a failed integration as a refusal that says nothing reached the project', async () => {
      conflict();
      const before = main();
      const result = await flow({ runAgent: async () => ({ ok: false, summary: 'the tasks disagree.' }) });
      expect(result.status).toBe('refused');
      expect(result.status === 'refused' && result.message).toMatch(/the tasks disagree.*Nothing reached the project/);
      expect(main()).toBe(before);
    });

    describe('spends nothing on an agent when the merge could not happen anyway', () => {
      it('the project is on another branch', async () => {
        conflict();
        git(repo, 'checkout', '-q', '-b', 'elsewhere');
        const runAgent = vi.fn(resolving);
        await expect(flow({ runAgent })).resolves.toMatchObject({ status: 'refused' });
        expect(runAgent).not.toHaveBeenCalled();
      });

      it('the task folder has edits QA did not review', async () => {
        conflict();
        writeFileSync(join(wt, 'task.txt'), 'unreviewed\n');
        const runAgent = vi.fn(resolving);
        const result = await flow({ runAgent, uncommittedApproved: async () => false });
        expect(result.status).toBe('refused');
        expect(runAgent).not.toHaveBeenCalled();
        expect(readFileSync(join(wt, 'task.txt'), 'utf-8')).toBe('unreviewed\n');
      });
    });

    it('without a task folder, git alone decides', async () => {
      await expect(flow({ worktreePath: undefined })).resolves.toMatchObject({ status: 'merged' });
    });

    it('stage only: staged, for the user to commit', async () => {
      mainMovedElsewhere();
      await expect(flow({ stageOnly: true, runAgent: async () => OK })).resolves.toMatchObject({ status: 'staged' });
    });
  });

  describe('getMergeState: what the board shows after the window is closed', () => {
    const flow = (runAgent: IntegrateTaskOptions['runAgent'], confirmed = false) => integrateAndMerge({
      projectDir: repo, branch: BRANCH, baseBranch: 'main', worktreePath: wt, message: 'Merge', stageOnly: false, confirmed, runAgent,
    });
    const state = (merging = false) => getMergeState({ worktreePath: wt, merging });

    it('nothing to say about a task nobody merged', async () => {
      await expect(state()).resolves.toBeNull();
    });

    it('merging or waiting to comes first', async () => {
      await expect(state(true)).resolves.toEqual({ state: 'merging' });
    });

    it('knows without a task folder that a merge is on, and nothing else', async () => {
      await expect(getMergeState({ merging: true })).resolves.toEqual({ state: 'merging' });
      await expect(getMergeState({ merging: false })).resolves.toBeNull();
    });

    it("remembers why a merge failed, and it survives the window: it's on disk", async () => {
      conflict();
      await flow(async () => ({ ok: false, summary: 'the tasks disagree.' }));
      const result = await state();
      expect(result?.state).toBe('failed');
      expect(result?.state === 'failed' && result.reason).toMatch(/the tasks disagree/);
    });

    it('says a merge waits for the user', async () => {
      conflict();
      await flow(resolving);
      await expect(state()).resolves.toEqual({ state: 'review' });
    });

    it('a new try wipes the old failure', async () => {
      conflict();
      await flow(async () => ({ ok: false, summary: 'no' }));
      await flow(resolving);
      await expect(state()).resolves.toEqual({ state: 'review' });
    });

    it('a failure says nothing once the task has moved on', async () => {
      conflict();
      await flow(async () => ({ ok: false, summary: 'no' }));
      writeFileSync(join(wt, 'task.txt'), 'fixed by hand\n');
      commitAll(wt, 'by hand');
      await expect(state()).resolves.toBeNull();
    });

    it('a refusal before any agent ran is remembered too', async () => {
      git(repo, 'checkout', '-q', '-b', 'elsewhere');
      await flow(resolving);
      const result = await state();
      expect(result?.state === 'failed' && result.reason).toMatch(/"elsewhere"/);
    });

    it('a broken step comes back as a failure, not an exception that loses it', async () => {
      const result = await integrateAndMerge({
        projectDir: join(repo, 'no-such-folder'), branch: BRANCH, baseBranch: 'main', worktreePath: wt, message: 'Merge', stageOnly: false, confirmed: false, runAgent: resolving,
      });
      expect(result.status).toBe('refused');
    });
  });

  describe('ten tasks finished at once, all touching the same file', () => {
    const TASKS = Array.from({ length: 10 }, (_, i) => `task-${i}`);

    it('all reach main, with nothing lost, and the project is never left in a merge', async () => {
      const folders = new Map<string, string>();
      for (const name of TASKS) {
        const folder = join(repo, '.vibe-teamlead', 'worktrees', 'tasks', name);
        git(repo, 'worktree', 'add', '-q', '-b', `vibe-teamlead/${name}`, folder, 'main');
        writeFileSync(join(folder, 'shared.txt'), `one\n${name}\n`);
        commitAll(folder, `${name} work`);
        folders.set(name, folder);
      }
      // What a working agent does with this file: keep every side's lines
      const keepBoth = (folder: string) => async (): Promise<IntegrationAgentAnswer> => {
        const file = join(folder, 'shared.txt');
        const lines = readFileSync(file, 'utf-8').split('\n').filter((line) => line && !/^(<{7}|={7}|>{7})/.test(line));
        writeFileSync(file, `${[...new Set(lines)].join('\n')}\n`);
        return OK;
      };
      let projectWasMidMerge = false;

      const results = await Promise.all(TASKS.map((name) => inMergeQueue(repo, name, async () => {
        const folder = folders.get(name) ?? '';
        projectWasMidMerge ||= existsSync(join(repo, '.git', 'MERGE_HEAD'));
        const merge = (confirmed: boolean) => integrateAndMerge({ projectDir: repo, branch: `vibe-teamlead/${name}`, baseBranch: 'main', worktreePath: folder, message: `Merge ${name}`, stageOnly: false, confirmed, runAgent: keepBoth(folder) });
        const result = await merge(false);
        // The user confirms what the agent did
        return result.status === 'needs_review' ? merge(true) : result;
      })));

      expect(results.map((result) => result.status)).toEqual(TASKS.map(() => 'merged'));
      expect(projectWasMidMerge).toBe(false);
      const merged = readFileSync(join(repo, 'shared.txt'), 'utf-8');
      for (const name of TASKS) {
        expect(merged).toContain(name);
        expect(has(`vibe-teamlead/${name}`, 'main')).toBe(true);
      }
    }, 60_000);
  });

  it('runs no hooks: a branch could bring its own', async () => {
    conflict();
    const marker = join(repo, 'hook-ran');
    mkdirSync(join(repo, '.git', 'tracked-hooks'));
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'reference-transaction']) {
      writeFileSync(join(repo, '.git', 'tracked-hooks', name), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(repo, '.git', 'tracked-hooks', name), 0o755);
    }
    git(repo, 'config', 'core.hooksPath', '.git/tracked-hooks');
    await integrate(resolving);
    expect(existsSync(marker)).toBe(false);
  });

  describe('an interrupted or foreign merge in the task folder', () => {
    beforeEach(conflict);
    const openMerge = () => expect(() => git(wt, 'merge', 'main')).toThrow();
    const markFile = () => git(wt, 'rev-parse', '--path-format=absolute', '--git-path', INTEGRATION_FILE);

    it('starts over when the app stopped in the middle of integrating', async () => {
      const before = tip();
      writeFileSync(markFile(), JSON.stringify({ state: 'running', before }));
      openMerge();
      await expect(integrate(resolving)).resolves.toMatchObject({ status: 'needs_review' });
      expect(has(main(), tip())).toBe(true);
      expect(has(before, tip())).toBe(true);
    });

    it("leaves a merge it didn't start alone", async () => {
      openMerge();
      const runAgent = vi.fn(resolving);
      const result = await integrate(runAgent);
      expect(result.status).toBe('failed');
      expect(runAgent).not.toHaveBeenCalled();
      expect(existsSync(join(repo, '.git', 'worktrees', '001-task', 'MERGE_HEAD'))).toBe(true);
    });
  });

  describe('the review', () => {
    beforeEach(conflict);

    it('shows what changes in the project, and how it differs from the task', async () => {
      await integrate(resolving);
      const project = await getIntegrationReviewDiff({ ...reviewOptions(), file: 'shared.txt', against: 'project' });
      expect(project?.diff).toContain('-main side');
      expect(project?.diff).toContain('+both sides');
      expect(project?.truncated).toBe(false);
      const task = await getIntegrationReviewDiff({ ...reviewOptions(), file: 'shared.txt', against: 'task' });
      expect(task?.diff).toContain('-task side');
      expect(task?.diff).toContain('+both sides');
    });

    it("the diff follows the user's edits", async () => {
      await integrate(resolving);
      writeFileSync(join(wt, 'shared.txt'), 'corrected by hand\n');
      const result = await getIntegrationReviewDiff({ ...reviewOptions(), file: 'shared.txt', against: 'project' });
      expect(result?.diff).toContain('+corrected by hand');
    });

    it("shows the text even when the branch's .gitattributes calls the file binary", async () => {
      writeFileSync(join(wt, '.gitattributes'), 'shared.txt -diff\n');
      commitAll(wt, 'task hides the file from diffs');
      await integrate(resolving);
      const result = await getIntegrationReviewDiff({ ...reviewOptions(), file: 'shared.txt', against: 'project' });
      expect(result?.diff).toContain('+both sides');
    });

    it('gives no diff for a file outside the review, or without a review', async () => {
      await expect(getIntegrationReviewDiff({ ...reviewOptions(), file: 'shared.txt', against: 'project' })).resolves.toBeNull();
      await integrate(resolving);
      await expect(getIntegrationReviewDiff({ ...reviewOptions(), file: 'task.txt', against: 'project' })).resolves.toBeNull();
      await expect(getIntegrationReviewDiff({ ...reviewOptions(), file: '../../etc/passwd', against: 'project' })).resolves.toBeNull();
    });

    it('cuts a huge diff and says so', async () => {
      await integrate(async () => {
        writeFileSync(join(wt, 'shared.txt'), 'line of text\n'.repeat(60_000));
        return OK;
      });
      const result = await getIntegrationReviewDiff({ ...reviewOptions(), file: 'shared.txt', against: 'project' });
      expect(result?.truncated).toBe(true);
      expect(result?.diff.length).toBeLessThanOrEqual(256 * 1024);
    });

    it('cancelling puts the task back as it was, the user\'s edits included', async () => {
      const before = tip();
      await integrate(resolving);
      writeFileSync(join(wt, 'shared.txt'), 'corrected by hand\n');
      await expect(cancelIntegrationReview(reviewOptions())).resolves.toBe(true);
      expect(tip()).toBe(before);
      expect(readFileSync(join(wt, 'shared.txt'), 'utf-8')).toBe('task side\n');
      await expect(getIntegrationReview(reviewOptions())).resolves.toBeNull();
    });

    it('nothing to review once the task moved on', async () => {
      await integrate(resolving);
      writeFileSync(join(wt, 'task.txt'), 'later work\n');
      commitAll(wt, 'later');
      await expect(getIntegrationReview(reviewOptions())).resolves.toBeNull();
      await expect(cancelIntegrationReview(reviewOptions())).resolves.toBe(false);
    });

    it('stays while the user decides: the task still has the latest main', async () => {
      await integrate(resolving);
      const runAgent = vi.fn(resolving);
      await expect(integrate(runAgent)).resolves.toEqual({ status: 'up_to_date' });
      expect(runAgent).not.toHaveBeenCalled();
      await expect(getIntegrationReview(reviewOptions())).resolves.not.toBeNull();
    });

    it('integrates again when main moved while the user was deciding', async () => {
      await integrate(resolving);
      mainMovedElsewhere();
      const runAgent = vi.fn(async () => OK);
      await expect(integrate(runAgent)).resolves.toEqual({ status: 'verified', summary: OK.summary });
      expect(runAgent).toHaveBeenCalled();
      expect(has(main(), tip())).toBe(true);
    });
  });
});
