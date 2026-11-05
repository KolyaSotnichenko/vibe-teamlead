import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => Promise<{ success: boolean; error?: string }>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: never) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp', getVersion: () => '0' },
  safeStorage: {},
}));
const found = { task: { id: 't', specId: 's', status: 'human_review', subtasks: [] }, project: { id: 'p', path: '/no/such/project' } };
vi.mock('../shared', () => ({ findTaskAndProject: () => found }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => null }));
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
