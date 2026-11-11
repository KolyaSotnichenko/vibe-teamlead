import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => Promise<{ success: boolean; data?: { message?: string } }>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: never) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp', getVersion: () => '0' },
  safeStorage: {},
}));
const found = {
  task: { id: 't', specId: 's', title: 'T', status: 'human_review', subtasks: [] },
  project: { id: 'p', path: '/no/such/project', settings: { mainBranch: 'main', deploy: { enabled: true, repo: { owner: 'me', repo: 'app', createdByApp: true } } } },
};
vi.mock('../shared', () => ({ findTaskAndProject: () => found }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => null }));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: { handleManualStatusChange: vi.fn(), configure: vi.fn() } }));
vi.mock('../../../project-store', () => ({ projectStore: {} }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));
vi.mock('../../../ai/claude-code/credential', () => ({ resolveClaudeCredential: vi.fn() }));
const merge = vi.hoisted(() => ({ result: { status: 'merged' } as { status: string } }));
vi.mock('../../../ai/merge/integrate-task', () => ({
  integrateAndMerge: async () => merge.result,
  cancelIntegrationReview: vi.fn(),
  INTEGRATION_FILE: 'x',
}));
vi.mock('../plan-file-utils', () => ({ persistPlanStatus: vi.fn(async () => true), updateTaskMetadataPrUrl: vi.fn() }));
const pushMain = vi.hoisted(() => vi.fn(async () => ({ pushed: true })));
vi.mock('../../../deploy/push-after-merge', () => ({ pushMainAfterMerge: pushMain }));
vi.mock('../../../deploy/github-write', () => ({ pushWithAppToken: vi.fn() }));

import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerWorktreeHandlers } from '../worktree-handlers';

const mergeTask = (options?: unknown) => handlers.get(IPC_CHANNELS.TASK_WORKTREE_MERGE)!({}, 't', options);

describe('merge into main pushes main', () => {
  beforeEach(() => {
    pushMain.mockClear();
    handlers.clear();
    registerWorktreeHandlers(() => null);
  });

  it('calls the push hook once after a full merge', async () => {
    merge.result = { status: 'merged' };
    const r = await mergeTask({});
    expect(r.success).toBe(true);
    expect(pushMain).toHaveBeenCalledTimes(1);
    expect((pushMain.mock.calls[0] as unknown[])[0]).toBe(found.project);
    expect((pushMain.mock.calls[0] as unknown[])[2]).toBe('main');
  });

  it('does not call it for a stage-only merge', async () => {
    merge.result = { status: 'staged' };
    await mergeTask({ noCommit: true });
    expect(pushMain).not.toHaveBeenCalled();
  });

  it('does not call it for a failed merge', async () => {
    merge.result = { status: 'refused' };
    await mergeTask({});
    expect(pushMain).not.toHaveBeenCalled();
  });
});
