/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReadinessResult, ReadinessState } from '../../../../shared/types/deploy';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../project-settings/GitHubOAuthFlow', () => ({ GitHubOAuthFlow: () => <p>github-oauth-flow</p> }));

import { DeployPage } from '../DeployPage';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const result = (over: Partial<ReadinessResult> = {}): ReadinessResult => ({
  scannedAt: '2026-11-11T10:00:00Z',
  blockers: [
    { key: 'code:a', kind: 'code', subject: 'a', title: 'Fix the build', detail: 'Build fails' },
    { key: 'workflow:b', kind: 'workflow', subject: 'b', title: 'Add a workflow', detail: 'No CI' },
    { key: 'unsupported:c', kind: 'unsupported', subject: 'c', title: 'Cron on a VPS', detail: 'Runs on a server' },
  ],
  services: [],
  owner: [],
  workflow: { path: '.github/workflows/ci.yml', lastMainRun: { conclusion: 'success', runId: 7 } },
  ...over,
});

function setup(state: ReadinessState, opts: { onGoToTask?: (id: string) => void } = {}) {
  let push: ((u: { projectId: string; state: ReadinessState }) => void) | undefined;
  const deploy = {
    startRuns: vi.fn(async () => ({ success: true })),
    stopRuns: vi.fn(async () => ({ success: true })),
    selectRun: vi.fn(async () => ({ success: true })),
    onRunsUpdate: vi.fn(() => () => undefined),
    state: vi.fn(async () => ({ success: true, data: { settings: { enabled: true }, setupRunning: false, databaseRunning: false } })),
    onSetupProgress: vi.fn(() => () => undefined),
    onPushResult: vi.fn(() => () => undefined),
    onDatabaseProgress: vi.fn(() => () => undefined),
    readinessState: vi.fn(async () => ({ success: true, data: state })),
    scanReadiness: vi.fn(async () => ({ success: true })),
    onReadinessUpdate: vi.fn((cb: typeof push) => { push = cb; return () => undefined; }),
    setVariable: vi.fn(async () => ({ success: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deploy,
    openExternal: vi.fn(),
    getGitHubAppAccess: vi.fn(async () => ({ success: true, data: { installed: true } })),
    vercel: { status: vi.fn(async () => ({ success: true, data: { connected: false } })) },
  };
  render(<DeployPage projectId="p1" onGoToTask={opts.onGoToTask} />);
  const emit = (s: ReadinessState) => act(() => push?.({ projectId: 'p1', state: s }));
  return { deploy, emit };
}

const openTab = async () => {
  const tab = await screen.findByRole('tab', { name: /deploy:tabs\.readiness/ });
  fireEvent.click(tab);
  return tab;
};

describe('Readiness tab', () => {
  it('scans once on first open when there is no result', async () => {
    const { deploy } = setup({ scanning: false, tasks: {} });
    await waitFor(() => expect(deploy.scanReadiness).toHaveBeenCalledTimes(1));
    expect(deploy.scanReadiness).toHaveBeenCalledWith('p1', 'open');
  });

  it('does not scan when a result is saved, or while a scan runs', async () => {
    const a = setup({ result: result(), scanning: false, tasks: {} });
    await screen.findByRole('tab', { name: /deploy:tabs\.readiness/ });
    await waitFor(() => expect(a.deploy.readinessState).toHaveBeenCalled());
    await act(async () => undefined);
    expect(a.deploy.scanReadiness).not.toHaveBeenCalled();
    cleanup();
    const b = setup({ scanning: true, tasks: {} });
    await waitFor(() => expect(b.deploy.readinessState).toHaveBeenCalled());
    await act(async () => undefined);
    expect(b.deploy.scanReadiness).not.toHaveBeenCalled();
  });

  it('counts code and workflow blockers in the tab label, not unsupported', async () => {
    setup({ result: result(), scanning: false, tasks: {} });
    const tab = await screen.findByRole('tab', { name: /deploy:tabs\.readiness/ });
    await waitFor(() => expect(tab).toHaveTextContent('2'));
    expect(tab).not.toHaveTextContent('3');
  });

  it('shows the task link and its status, and opens the task', async () => {
    const onGoToTask = vi.fn();
    setup({ result: result(), scanning: false, tasks: { 'code:a': { specId: '012-fix', status: 'in_progress' } } }, { onGoToTask });
    await openTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Fix the build' }));
    expect(onGoToTask).toHaveBeenCalledWith('012-fix');
    expect(screen.getByText('deploy:readiness.taskStatus.in_progress')).toBeInTheDocument();
  });

  it('shows the unsupported reason and no task', async () => {
    setup({ result: result(), scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByText('deploy:readiness.unsupported')).toBeInTheDocument();
    expect(screen.getByText('Runs on a server')).toBeInTheDocument();
  });

  it('disables Check again while scanning and runs a check when clicked', async () => {
    const { deploy, emit } = setup({ result: result(), scanning: false, tasks: {} });
    await openTab();
    const button = await screen.findByRole('button', { name: 'deploy:readiness.checkAgain' });
    fireEvent.click(button);
    expect(deploy.scanReadiness).toHaveBeenCalledWith('p1', 'check-again');
    emit({ result: result(), scanning: true, tasks: {} });
    expect(screen.getByRole('button', { name: 'deploy:readiness.checkAgain' })).toBeDisabled();
    expect(screen.getByText('deploy:readiness.scanning')).toBeInTheDocument();
  });

  it('keeps the previous list under the error notice, never the raw error', async () => {
    setup({ result: result(), scanning: false, error: 'The readiness scan failed. Try again.', tasks: {} });
    await openTab();
    expect(await screen.findByText('deploy:readiness.error')).toBeInTheDocument();
    expect(screen.queryByText('The readiness scan failed. Try again.')).toBeNull();
    expect(screen.getByText('Fix the build')).toBeInTheDocument();
  });

  it('opens the variable dialog with the name prefilled', async () => {
    setup({
      result: result({ owner: [{ kind: 'variable', variable: 'STRIPE_KEY', message: 'Add it' }] }),
      scanning: false,
      tasks: {},
    });
    await openTab();
    fireEvent.click(await screen.findByRole('button', { name: 'deploy:readiness.addValue' }));
    expect(await screen.findByDisplayValue('STRIPE_KEY')).toBeInTheDocument();
  });

  it('says nothing blocks deploy', async () => {
    setup({ result: result({ blockers: [] }), scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByText('deploy:readiness.clear')).toBeInTheDocument();
  });

  it('shows the last run result by a mapped key with a mark', async () => {
    setup({ result: result({ workflow: { path: 'ci.yml', lastMainRun: { conclusion: 'failure', runId: 7 } } }), scanning: false, tasks: {} });
    await openTab();
    const text = await screen.findByText('deploy:readiness.conclusions.failure');
    expect(text.parentElement?.querySelector('[data-marker="attention"]')).not.toBeNull();
  });

  it('falls back for an unknown conclusion', async () => {
    setup({ result: result({ workflow: { path: 'ci.yml', lastMainRun: { conclusion: 'weird', runId: 7 } } }), scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByText('deploy:readiness.conclusions.unknown')).toBeInTheDocument();
  });
});
