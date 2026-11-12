import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';

const client = vi.hoisted(() => ({
  runs: vi.fn(async () => []),
  jobs: vi.fn(async () => []),
  workflowFile: vi.fn(async () => null),
  deployments: vi.fn(async () => []),
  productionUrl: vi.fn(async () => null),
  jobLog: vi.fn(async () => 'line'),
}));
vi.mock('../../deploy/github-actions', () => ({
  createActionsClient: () => client,
  resolveRepo: vi.fn(async () => ({ owner: 'o', repo: 'r' })),
}));
const scanReadiness = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../deploy/readiness', () => ({
  createReadiness: () => ({ state: () => ({ scanning: false, tasks: {} }), scan: scanReadiness }),
}));
vi.mock('../../deploy/github-fetcher', () => ({ githubFetcher: vi.fn() }));
vi.mock('../../project-store', () => ({
  projectStore: { getProject: vi.fn((id: string) => (id === 'p1' ? { id: 'p1', path: '/p1', settings: {} } : undefined)) },
}));

import { resolveRepo } from '../../deploy/github-actions';
import { registerDeployHandlers } from '../deploy-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('deploy IPC', () => {
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), on: vi.fn(), once: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
    registerDeployHandlers(() => window as never);
  });

  it('a job log uses the repo the poller resolved, without resolving again', async () => {
    await invoke(IPC_CHANNELS.DEPLOY_RUNS_START, 'p1');
    await flush();
    expect(resolveRepo).toHaveBeenCalledTimes(1);
    const result = await invoke(IPC_CHANNELS.DEPLOY_JOB_LOG, 'p1', 5);
    expect(result).toEqual({ success: true, data: { state: 'ready', text: 'line' } });
    expect(client.jobLog).toHaveBeenCalledWith('o', 'r', 5);
    expect(resolveRepo).toHaveBeenCalledTimes(1);
    await invoke(IPC_CHANNELS.DEPLOY_RUNS_STOP, 'p1');
  });

  it('a job log for a project the poller is not on fails without resolving', async () => {
    const result = await invoke(IPC_CHANNELS.DEPLOY_JOB_LOG, 'p1', 5);
    expect(result).toMatchObject({ success: false });
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(client.jobLog).not.toHaveBeenCalled();
  });

  it('readiness state comes from the orchestrator; unknown project fails', async () => {
    expect(await invoke(IPC_CHANNELS.DEPLOY_READINESS_STATE, 'p1')).toEqual({ success: true, data: { scanning: false, tasks: {} } });
    expect(await invoke(IPC_CHANNELS.DEPLOY_READINESS_STATE, 'nope')).toMatchObject({ success: false });
  });

  it('scanReadiness defaults to check-again and accepts open only', async () => {
    await invoke(IPC_CHANNELS.DEPLOY_READINESS_SCAN, 'p1');
    await invoke(IPC_CHANNELS.DEPLOY_READINESS_SCAN, 'p1', 'open');
    await invoke(IPC_CHANNELS.DEPLOY_READINESS_SCAN, 'p1', 'merge');
    expect(scanReadiness.mock.calls.map((c) => c[1])).toEqual(['check-again', 'open', 'check-again']);
    expect(await invoke(IPC_CHANNELS.DEPLOY_READINESS_SCAN, 'nope')).toMatchObject({ success: false });
  });
});
