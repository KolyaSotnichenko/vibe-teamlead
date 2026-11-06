import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => Promise<{ success: boolean; error?: string }>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: never) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp', getVersion: () => '0' },
  safeStorage: {},
}));
const found = { task: { id: 't', specId: 's', status: 'human_review', subtasks: [] }, project: { id: 'p', path: '/no/such/project' } };
const NO_PROJECT = found.project.path;
vi.mock('../shared', () => ({ findTaskAndProject: () => found }));
const worktree = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => worktree.path }));
vi.mock('../../../ai/orchestration/qa-rerun', () => ({ requestQaRerun: vi.fn() }));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: { prepareForRestart: vi.fn(), handleUiEvent: vi.fn(), configure: vi.fn() } }));
vi.mock('../../../file-watcher', () => ({ fileWatcher: { unwatch: vi.fn(), watch: vi.fn() } }));
vi.mock('../../../project-store', () => ({ projectStore: {} }));
vi.mock('../../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../agent-events-handlers', () => ({ cancelFallbackTimer: vi.fn() }));
vi.mock('../../../project-initializer', () => ({ checkGitStatus: vi.fn() }));
vi.mock('../../../ai/claude-code/credential', () => ({ resolveClaudeCredential: vi.fn() }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { IPC_CHANNELS } from '../../../../shared/constants';
import { INTEGRATION_FILE } from '../../../ai/merge/integrate-task';
import { inMergeQueue } from '../../../ai/merge/merge-queue';
import { requestQaRerun } from '../../../ai/orchestration/qa-rerun';
import { registerTaskExecutionHandlers } from '../execution-handlers';

const agent = { isRunning: vi.fn(), startQAProcess: vi.fn(), killTask: vi.fn() };
const review = () => handlers.get(IPC_CHANNELS.TASK_REVIEW)!({}, 't', false, undefined, undefined, { rerunOnly: true });

beforeEach(() => {
  vi.clearAllMocks();
  registerTaskExecutionHandlers(agent as never, () => null);
});

describe('review while an agent is working', () => {
  it("doesn't start QA over a running agent, which would kill it", async () => {
    agent.isRunning.mockReturnValue(true);
    expect((await review()).success).toBe(false);
    expect(agent.startQAProcess).not.toHaveBeenCalled();
    expect(requestQaRerun).not.toHaveBeenCalled();
  });

  it('starts QA when nothing is running', async () => {
    agent.isRunning.mockReturnValue(false);
    await review();
    expect(requestQaRerun).toHaveBeenCalled();
    expect(agent.startQAProcess).toHaveBeenCalled();
  });
});

describe('review of a task with a worktree', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vt-review-')));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'one');
    found.project.path = repo;
    worktree.path = join(repo, '.vibe-teamlead/worktrees/tasks/s');
    mkdirSync(join(worktree.path, '.vibe-teamlead/specs/s'), { recursive: true });
    agent.isRunning.mockReturnValue(false);
  });

  afterEach(() => {
    found.project.path = NO_PROJECT;
    worktree.path = null;
    rmSync(repo, { recursive: true, force: true });
  });

  it("leaves the user's uncommitted work in the project alone", async () => {
    writeFileSync(join(repo, 'a.txt'), 'my edit\n');
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');

    expect((await review()).success).toBe(true);

    expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('my edit\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(true);
    expect(git('diff', '--cached', '--name-only').trim()).toBe('staged.txt');
    expect(agent.startQAProcess).toHaveBeenCalled();
  });

  describe('and a merge', () => {
    const inFolder = (...args: string[]) => execFileSync('git', args, { cwd: worktree.path ?? '', encoding: 'utf-8', stdio: 'pipe' }).trim();

    beforeEach(() => {
      rmSync(worktree.path ?? '', { recursive: true });
      git('worktree', 'add', '-qb', 'vibe-teamlead/s', worktree.path ?? '');
    });

    it('refuses while the agent\'s merge waits for confirmation, and keeps it', async () => {
      const tip = inFolder('rev-parse', 'HEAD');
      const mark = inFolder('rev-parse', '--path-format=absolute', '--git-path', INTEGRATION_FILE);
      writeFileSync(mark, JSON.stringify({ state: 'review', before: tip, tip, files: ['a.txt'], summary: 'ok' }));

      const result = await review();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/merge/i);
      expect(agent.startQAProcess).not.toHaveBeenCalled();
      expect(existsSync(mark)).toBe(true);
    });

    it('refuses while the task is merging or waiting to: QA would run on a moving folder', async () => {
      let finish = () => {};
      const merging = inMergeQueue(repo, 't', () => new Promise<void>((resolve) => { finish = resolve; }));

      const result = await review();

      expect(result.success).toBe(false);
      expect(agent.startQAProcess).not.toHaveBeenCalled();
      finish();
      await merging;
    });
  });
});
