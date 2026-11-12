/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  ],
  owner: [],
  workflow: { path: '.github/workflows/ci.yml', lastMainRun: { conclusion: 'success', runId: 7 } },
  ...over,
});

function setup(state: ReadinessState, opts: { onGoToTask?: (id: string) => void; setUp?: boolean; secrets?: string[] } = {}) {
  const settings = opts.setUp === false ? { enabled: false } : { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: true } };
  let push: ((u: { projectId: string; state: ReadinessState }) => void) | undefined;
  const deploy = {
    startRuns: vi.fn(async () => ({ success: true })),
    stopRuns: vi.fn(async () => ({ success: true })),
    selectRun: vi.fn(async () => ({ success: true })),
    onRunsUpdate: vi.fn(() => () => undefined),
    state: vi.fn(async () => ({ success: true, data: { settings, setupRunning: false } })),
    onSetupProgress: vi.fn(() => () => undefined),
    onPushResult: vi.fn(() => () => undefined),
    readinessState: vi.fn(async () => ({ success: true, data: state })),
    scanReadiness: vi.fn(async () => ({ success: true })),
    onReadinessUpdate: vi.fn((cb: typeof push) => { push = cb; return () => undefined; }),
    listSecrets: vi.fn(async () => ({ success: true, data: { ok: true, names: opts.secrets ?? [] } })),
    setSecret: vi.fn(async () => ({ success: true, data: { ok: true } })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deploy,
    openExternal: vi.fn(),
    getGitHubAppAccess: vi.fn(async () => ({ success: true, data: { installed: true } })),
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

  /** An old Deploy result as it may still reach the renderer */
  const oldUnsupported = { key: 'unsupported:c', kind: 'unsupported', subject: 'c', title: 'Cron on a VPS', detail: 'Runs on a server' } as unknown as ReadinessResult['blockers'][number];

  it('counts code and workflow blockers in the tab label, never an old unsupported one', async () => {
    setup({ result: result({ blockers: [...result().blockers, oldUnsupported] }), scanning: false, tasks: {} });
    const tab = await screen.findByRole('tab', { name: /deploy:tabs\.readiness/ });
    await waitFor(() => expect(tab).toHaveTextContent('2'));
    expect(tab).not.toHaveTextContent('3');
  });

  it('shows no old unsupported blocker and no services', async () => {
    setup({ result: { ...result({ blockers: [...result().blockers, oldUnsupported] }), services: [{ kind: 'postgres' }] }, scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByText('Fix the build')).toBeInTheDocument();
    expect(screen.queryByText('Cron on a VPS')).toBeNull();
    expect(screen.queryByText(/unsupported/)).toBeNull();
    expect(screen.queryByText(/postgres/i)).toBeNull();
  });

  it('shows the task link and its status, and opens the task', async () => {
    const onGoToTask = vi.fn();
    setup({ result: result(), scanning: false, tasks: { 'code:a': { specId: '012-fix', status: 'in_progress' } } }, { onGoToTask });
    await openTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Fix the build' }));
    expect(onGoToTask).toHaveBeenCalledWith('012-fix');
    expect(screen.getByText('deploy:readiness.taskStatus.in_progress')).toBeInTheDocument();
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

  const secrets = (over: Partial<ReadinessResult> = {}) =>
    result({
      owner: [
        { kind: 'secret', variable: 'CSRF_SECRET', message: 'x' },
        { kind: 'secret', variable: 'NPM_TOKEN', message: 'y' },
        { kind: 'other', message: 'Turn on billing' },
      ],
      ...over,
    });
  const ownerSection = () => document.getElementById('deploy-readiness-owner')?.closest('section') as HTMLElement;

  it('before CI is set up: a secret item says Set up CI first; no button, no listing, no count', async () => {
    const { deploy } = setup({ result: secrets(), scanning: false, tasks: {} }, { setUp: false });
    await openTab();
    const name = await screen.findByText('CSRF_SECRET');
    expect(within(name.closest('li') as HTMLElement).getByText('deploy:readiness.setUpCiFirst')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'deploy:readiness.addSecret' })).toBeNull();
    expect(screen.getByText('Turn on billing')).toBeInTheDocument();
    expect(screen.queryByText(/deploy:readiness\.secretsLeft/)).toBeNull();
    expect(deploy.listSecrets).not.toHaveBeenCalled();
  });

  it('after setup: secrets GitHub has are not listed, and the notice counts the rest', async () => {
    const { deploy } = setup({ result: secrets(), scanning: false, tasks: {} }, { secrets: ['NPM_TOKEN'] });
    await openTab();
    await waitFor(() => expect(deploy.listSecrets).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByText('NPM_TOKEN')).toBeNull());
    expect(screen.getByText('CSRF_SECRET')).toBeInTheDocument();
    expect(screen.getByText('deploy:readiness.secretsLeft {"count":1}')).toBeInTheDocument();
    expect(screen.queryByText('deploy:readiness.setUpCiFirst')).toBeNull();
  });

  it('an old variable item is a secret', async () => {
    const old = result({ owner: [{ kind: 'variable', variable: 'CSRF_SECRET', message: 'x' }] as unknown as ReadinessResult['owner'] });
    setup({ result: old, scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByRole('button', { name: 'deploy:readiness.addSecret' })).toBeInTheDocument();
  });

  it('a secret saved from the item goes to GitHub and the item is gone without a new check', async () => {
    const { deploy } = setup({ result: secrets(), scanning: false, tasks: {} });
    await openTab();
    await waitFor(() => expect(deploy.listSecrets).toHaveBeenCalled());
    const item = (await screen.findByText('CSRF_SECRET')).closest('li') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: 'deploy:readiness.addSecret' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('deploy:secretDialog.name') as HTMLInputElement).value).toBe('CSRF_SECRET');
    fireEvent.change(within(dialog).getByLabelText('deploy:secretDialog.value'), { target: { value: 'v4lue' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:secretDialog.save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deploy.setSecret).toHaveBeenCalledWith('p1', 'CSRF_SECRET', 'v4lue');
    expect(within(ownerSection()).queryByText('CSRF_SECRET')).toBeNull();
    expect(screen.getByText('deploy:readiness.secretSaved {"name":"CSRF_SECRET"}')).toBeInTheDocument();
    expect(screen.getByText('deploy:readiness.secretsLeft {"count":1}')).toBeInTheDocument();
    expect(deploy.scanReadiness).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('v4lue');
  });

  it('a new check clears the saved note and lists GitHub\'s secrets again', async () => {
    const { deploy, emit } = setup({ result: secrets(), scanning: false, tasks: {} });
    await openTab();
    await waitFor(() => expect(deploy.listSecrets).toHaveBeenCalledTimes(1));
    const item = (await screen.findByText('CSRF_SECRET')).closest('li') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: 'deploy:readiness.addSecret' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('deploy:secretDialog.value'), { target: { value: 'v' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:secretDialog.save' }));
    expect(await screen.findByText('deploy:readiness.secretSaved {"name":"CSRF_SECRET"}')).toBeInTheDocument();

    emit({ result: secrets(), scanning: true, tasks: {} });
    expect(screen.queryByText(/deploy:readiness\.secretSaved/)).toBeNull();
    emit({ result: secrets({ scannedAt: '2026-11-12T10:00:00Z' }), scanning: false, tasks: {} });
    await waitFor(() => expect(deploy.listSecrets).toHaveBeenCalledTimes(2));
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

  it('falls back for an inherited property name as a conclusion', async () => {
    setup({ result: result({ workflow: { path: 'ci.yml', lastMainRun: { conclusion: 'constructor', runId: 7 } } }), scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByText('deploy:readiness.conclusions.unknown')).toBeInTheDocument();
  });

  it('shows given-up keys under Needed from you: the blocker title, or the workflow with a link to the run', async () => {
    setup({
      result: result(),
      scanning: false,
      tasks: {},
      gaveUp: ['code:a', 'run:.github/workflows/ci.yml'],
      gaveUpLinks: { 'run:.github/workflows/ci.yml': 'https://github.com/o/r/actions/runs/3' },
    });
    await openTab();
    expect(await screen.findByText('deploy:readiness.owner')).toBeInTheDocument();
    expect(screen.getAllByText('deploy:readiness.gaveUp')).toHaveLength(2);
    const section = document.getElementById('deploy-readiness-owner')?.closest('section') as HTMLElement;
    expect(section).toHaveTextContent('Fix the build');
    expect(section).toHaveTextContent('.github/workflows/ci.yml');
    fireEvent.click(screen.getByRole('button', { name: 'deploy:readiness.openRun' }));
    expect((window as unknown as { electronAPI: { openExternal: ReturnType<typeof vi.fn> } }).electronAPI.openExternal).toHaveBeenCalledWith(
      'https://github.com/o/r/actions/runs/3',
    );
  });

  it('falls back for an unknown conclusion', async () => {
    setup({ result: result({ workflow: { path: 'ci.yml', lastMainRun: { conclusion: 'weird', runId: 7 } } }), scanning: false, tasks: {} });
    await openTab();
    expect(await screen.findByText('deploy:readiness.conclusions.unknown')).toBeInTheDocument();
  });
});
