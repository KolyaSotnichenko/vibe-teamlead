import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => Promise<{ success: boolean; error?: string; worktreeExists?: boolean }>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: never) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp', getVersion: () => '0' },
  safeStorage: {},
}));
const found = { task: { id: 't', specId: '001-s', status: 'human_review', subtasks: [] }, project: { id: 'p', path: '/no/such/project', autoBuildPath: '.vibe-teamlead' } };
vi.mock('../shared', () => ({ findTaskAndProject: () => found }));
const worktree = vi.hoisted(() => ({ path: '/no/such/project/.vibe-teamlead/worktrees/tasks/001-s' as string | null }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => worktree.path }));
const state = vi.hoisted(() => ({ handleManualStatusChange: vi.fn(() => true) }));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: { ...state, prepareForRestart: vi.fn(), handleUiEvent: vi.fn(), configure: vi.fn() } }));
vi.mock('../../../file-watcher', () => ({ fileWatcher: { unwatch: vi.fn(), watch: vi.fn() } }));
vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));
vi.mock('../../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../agent-events-handlers', () => ({ cancelFallbackTimer: vi.fn() }));
vi.mock('../../../project-initializer', () => ({ checkGitStatus: vi.fn() }));
vi.mock('../../../ai/claude-code/credential', () => ({ resolveClaudeCredential: vi.fn() }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));
const cleanup = vi.hoisted(() => ({ cleanupWorktree: vi.fn() }));
vi.mock('../../../utils/worktree-cleanup', () => cleanup);
const remote = vi.hoisted(() => ({ requestTaskBranchDelete: vi.fn() }));
vi.mock('../../../deploy/branch-push', () => remote);

import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerTaskExecutionHandlers } from '../execution-handlers';

const agent = { isRunning: vi.fn(() => false), killTask: vi.fn(), on: vi.fn() };
const done = (options?: unknown) => handlers.get(IPC_CHANNELS.TASK_UPDATE_STATUS)!({}, 't', 'done', options);

beforeEach(() => {
  vi.clearAllMocks();
  worktree.path = '/no/such/project/.vibe-teamlead/worktrees/tasks/001-s';
  registerTaskExecutionHandlers(agent as never, () => null);
});

// F-023: this handler removed the folder with its own copy of the cleanup, without what the shared
// one does (folders that deny deletion, retries, pruning, only-a-task-branch)
describe('marking a task done with its folder', () => {
  it('asks first when the folder exists and nothing was decided', async () => {
    expect(await done()).toMatchObject({ success: false, worktreeExists: true });
    expect(cleanup.cleanupWorktree).not.toHaveBeenCalled();
  });

  it('removes the folder and the branch with the shared cleanup, then the branch on GitHub', async () => {
    cleanup.cleanupWorktree.mockResolvedValue({ success: true, warnings: [] });
    expect(await done({ forceCleanup: true })).toEqual({ success: true });
    expect(cleanup.cleanupWorktree).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: worktree.path,
      projectPath: '/no/such/project',
      specId: '001-s',
      deleteBranch: true,
    }));
    expect(remote.requestTaskBranchDelete).toHaveBeenCalledWith(found.project, found.task);
    expect(state.handleManualStatusChange).toHaveBeenCalledWith('t', 'done', found.task, found.project);
  });

  it('does not mark the task done when the folder could not be removed, and says why', async () => {
    cleanup.cleanupWorktree.mockResolvedValue({ success: false, warnings: ['Permission denied', 'still there'] });
    const result = await done({ forceCleanup: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to cleanup worktree: Permission denied; still there');
    expect(remote.requestTaskBranchDelete).not.toHaveBeenCalled();
    expect(state.handleManualStatusChange).not.toHaveBeenCalled();
  });

  it('keeps the folder when the owner said so', async () => {
    expect(await done({ keepWorktree: true })).toEqual({ success: true });
    expect(cleanup.cleanupWorktree).not.toHaveBeenCalled();
    expect(remote.requestTaskBranchDelete).not.toHaveBeenCalled();
  });
});
