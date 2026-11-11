/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DeployJob, DeployJobLog, DeployRun, DeployRunsState, RunGraph } from '../../../../shared/types/deploy';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../project-settings/GitHubOAuthFlow', () => ({
  GitHubOAuthFlow: ({ onSuccess }: { onSuccess: (token: string) => void }) => (
    <button type="button" onClick={() => onSuccess('ghu_x')}>oauth-flow</button>
  ),
}));

import { DeployPage } from '../DeployPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const run = (id: number, over: Partial<DeployRun> = {}): DeployRun => ({
  id, number: id, name: 'CI', title: `Merge task ${id}`, branch: 'main', sha: `abcdef${id}123456`, event: 'push',
  status: 'completed', conclusion: 'success', startedAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:05:00Z',
  htmlUrl: `https://github.com/acme/app/actions/runs/${id}`, workflowPath: '.github/workflows/ci.yml', ...over,
});

const jobs: DeployJob[] = [
  { id: 11, name: 'typecheck', status: 'completed', conclusion: 'success', startedAt: '2026-11-11T10:00:00Z', completedAt: '2026-11-11T10:00:18Z',
    steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, startedAt: '2026-11-11T10:00:00Z', completedAt: '2026-11-11T10:00:04Z' },
      { name: 'npm run typecheck', status: 'completed', conclusion: 'success', number: 2 }] },
  { id: 12, name: 'e2e', status: 'in_progress', startedAt: '2026-11-11T10:00:20Z',
    steps: [{ name: 'npx playwright test', status: 'in_progress', number: 1 }] },
  { id: 13, name: 'unit', status: 'completed', conclusion: 'failure', steps: [{ name: 'npm test', status: 'completed', conclusion: 'failure', number: 1 }] },
];

const graph: RunGraph = {
  columns: [
    { stage: 'level-1', nodes: [
      { key: 'typecheck', label: 'typecheck', jobIds: [11], status: 'success' },
      { key: 'unit', label: 'unit', jobIds: [13], status: 'failure' },
    ] },
    { stage: 'level-2', nodes: [{ key: 'e2e', label: 'e2e', jobIds: [12], status: 'running' }] },
    { stage: 'deploy', nodes: [{ key: 'deploy:production', label: 'production', jobIds: [], status: 'queued' }] },
  ],
};

const base = (over: Partial<DeployRunsState> = {}): DeployRunsState => ({
  projectId: 'p1', repo: { owner: 'acme', repo: 'app' },
  runs: [run(18, { status: 'in_progress', conclusion: undefined }), run(17), run(16, { conclusion: 'failure' })],
  selected: { runId: 18, jobs, graph },
  productionUrl: 'https://app.vercel.app',
  nextPollAt: '2026-11-11T10:06:00Z',
  ...over,
});

function setup(log: DeployJobLog = { state: 'ready', text: 'line one\nline two' }) {
  let push: ((s: DeployRunsState) => void) | undefined;
  const unsubscribe = vi.fn();
  const deploy = {
    startRuns: vi.fn(async () => ({ success: true })),
    selectRun: vi.fn(async () => ({ success: true })),
    stopRuns: vi.fn(async () => ({ success: true })),
    jobLog: vi.fn(async () => ({ success: true, data: log })),
    onRunsUpdate: vi.fn((cb: (s: DeployRunsState) => void) => { push = cb; return unsubscribe; }),
  };
  const openExternal = vi.fn(async () => undefined);
  const getGitHubAppAccess = vi.fn(async (_repo?: string) => ({
    success: true,
    data: { installed: true, repositorySelection: 'all', repoReachable: true } as Record<string, unknown>,
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { deploy, openExternal, getGitHubAppAccess };
  const view = render(<DeployPage projectId="p1" />);
  const emit = (s: DeployRunsState) => act(() => push?.(s));
  return { deploy, emit, view, unsubscribe, openExternal, getGitHubAppAccess };
}

describe('DeployPage', () => {
  it('starts polling on mount and shows the runs with the newest selected', () => {
    const { deploy, emit } = setup();
    expect(deploy.startRuns).toHaveBeenCalledWith('p1', undefined);
    expect(screen.getByText('deploy:loading')).toBeInTheDocument();
    emit(base());
    const list = screen.getByRole('list', { name: 'deploy:runs.listLabel' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).not.toHaveAttribute('aria-current');
    expect(within(rows[0]).getByText('Merge task 18')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/#18 · main/)).toBeInTheDocument();
    // header of the selected run
    expect(screen.getByRole('heading', { name: /Merge task 18/ })).toBeInTheDocument();
    expect(screen.getByText(/push · main · abcdef1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'app.vercel.app' })).toBeInTheDocument();
  });

  it('ignores updates for another project', () => {
    const { emit } = setup();
    emit(base({ projectId: 'p2' }));
    expect(screen.getByText('deploy:loading')).toBeInTheDocument();
  });

  it('selects a run, and shows its header with a loading line until its graph arrives', () => {
    const { deploy, emit } = setup();
    emit(base());
    fireEvent.click(screen.getByText('Merge task 17'));
    expect(deploy.selectRun).toHaveBeenCalledWith('p1', 17);
    expect(screen.getByRole('heading', { name: /Merge task 17/ })).toBeInTheDocument();
    expect(screen.getByText('deploy:graph.loading')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^e2e/ })).not.toBeInTheDocument();
    emit(base({ selected: { runId: 17, jobs, graph } }));
    expect(screen.queryByText('deploy:graph.loading')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^e2e/ })).toBeInTheDocument();
  });

  it('draws the graph with stage labels and status markers', () => {
    const { emit } = setup();
    emit(base());
    expect(screen.getByText('deploy:graph.stage {"n":1}')).toBeInTheDocument();
    expect(screen.getByText('deploy:graph.deploy')).toBeInTheDocument();
    const running = screen.getByRole('button', { name: /^e2e/ });
    expect(running).toHaveAttribute('data-status', 'running');
    expect(running.querySelector('[data-marker="running"]')).not.toBeNull();
    expect(running.querySelector('[data-progress]')).not.toBeNull();
    const failed = screen.getByRole('button', { name: /^unit/ });
    expect(failed).toHaveAttribute('data-status', 'failure');
    expect(failed.querySelector('[data-marker="failure"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^typecheck/ }).querySelector('[data-marker="success"]')).not.toBeNull();
    // the line into the running column animates
    expect(document.querySelectorAll('[data-connector="live"]')).toHaveLength(1);
  });

  it('lets node labels wrap to two lines and gives the full label in a tooltip', () => {
    const { emit } = setup();
    emit(base());
    const node = screen.getByRole('button', { name: /^typecheck/ });
    expect(node).toHaveAttribute('title', 'typecheck');
    const label = within(node).getByText('typecheck');
    expect(label).toHaveClass('line-clamp-2');
    expect(label).not.toHaveClass('truncate');
  });

  it('names the jobs of a matrix node in its tooltip, and lets the panel pick a job', () => {
    const { emit } = setup();
    const matrixJobs: DeployJob[] = [
      { id: 21, name: 'Image (api)', status: 'completed', conclusion: 'success', steps: [{ name: 'build api', status: 'completed', conclusion: 'success', number: 1 }] },
      { id: 22, name: 'Image (web)', status: 'completed', conclusion: 'success', steps: [{ name: 'build web', status: 'completed', conclusion: 'success', number: 1 }] },
    ];
    const g: RunGraph = { columns: [{ stage: 'level-1', nodes: [{ key: 'image', label: 'Image …', jobIds: [21, 22], status: 'success' }] }] };
    emit(base({ selected: { runId: 18, jobs: matrixJobs, graph: g } }));
    const node = screen.getByRole('button', { name: /^Image …/ });
    expect(node).toHaveAttribute('title', 'Image …\nImage (api)\nImage (web)');
    fireEvent.click(node);
    expect(screen.getByText('build api')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Image \(web\)/ }));
    expect(screen.getByText('build web')).toBeInTheDocument();
    expect(screen.queryByText('build api')).not.toBeInTheDocument();
  });

  it('shows no duration for a deployment, and when it went live in the tooltip', () => {
    const { emit } = setup();
    const deployedAt = new Date(Date.now() - 18 * 86_400_000).toISOString();
    const g: RunGraph = { columns: [{ stage: 'deploy', nodes: [{ key: 'deploy:production', label: 'production', jobIds: [], status: 'success', deployedAt }] }] };
    emit(base({ selected: { runId: 18, jobs, graph: g } }));
    const node = screen.getByRole('button', { name: /^production/ });
    expect(node.textContent).not.toMatch(/\d+:\d{2}/);
    expect(node.getAttribute('aria-label')).not.toMatch(/\d+:\d{2}/);
    expect(node).toHaveAttribute('title', 'production\ndeploy:graph.deployed {"ago":"18 days ago"}');
  });

  it('scrolls the runs list in the app\'s thin scroll area', () => {
    const { emit } = setup();
    emit(base());
    const list = screen.getByRole('list', { name: 'deploy:runs.listLabel' });
    expect(list.closest('[data-radix-scroll-area-viewport]')).not.toBeNull();
  });

  it('shows the steps of a clicked completed job and its log', async () => {
    const { deploy, emit } = setup({ state: 'ready', text: 'line one\nline two' });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    expect(screen.getByText('npm run typecheck')).toBeInTheDocument();
    expect(screen.getByText('0:04')).toBeInTheDocument();
    await waitFor(() => expect(deploy.jobLog).toHaveBeenCalledWith('p1', 11));
    expect(await screen.findByText(/line one/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deploy:job.fullLog' }));
    expect(window.electronAPI.openExternal).toHaveBeenCalledWith('https://github.com/acme/app/actions/runs/18/job/11');
  });

  it('shows the log as main sent it (main trims it to the last 2 000 lines)', async () => {
    const text = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join('\n');
    const { emit } = setup({ state: 'ready', text });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    const log = await screen.findByTestId('job-log');
    expect(log.textContent).toBe(text);
  });

  it('does not fetch the log of a running job', () => {
    const { deploy, emit } = setup();
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^e2e/ }));
    expect(screen.getByText('npx playwright test')).toBeInTheDocument();
    expect(screen.getByText('deploy:log.pending')).toBeInTheDocument();
    expect(deploy.jobLog).not.toHaveBeenCalled();
  });

  it('says when GitHub no longer keeps a log', async () => {
    const { emit } = setup({ state: 'expired' });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    expect(await screen.findByText('deploy:log.expired')).toBeInTheDocument();
  });

  it('shows a log error with the page-level message for its kind', async () => {
    const { emit } = setup({ state: 'error', error: { kind: 'permissions', message: 'x' } });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    expect(await screen.findByText('deploy:errors.permissions')).toBeInTheDocument();
  });

  it('shows "no repository" when the project has none', () => {
    const { emit } = setup();
    emit({ projectId: 'p1', runs: [], nextPollAt: '' });
    expect(screen.getByText('deploy:empty.noRepo')).toBeInTheDocument();
  });

  it('shows "no runs" when there are none', () => {
    const { emit } = setup();
    emit(base({ runs: [], selected: undefined }));
    expect(screen.getByText('deploy:empty.noRuns')).toBeInTheDocument();
  });

  it('offers GitHub sign-in when not connected, and restarts after it', () => {
    const { deploy, emit } = setup();
    emit(base({ runs: [], selected: undefined, error: { kind: 'no-connection', message: '' } }));
    expect(screen.getByText('deploy:errors.no-connection')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deploy:errors.connect' }));
    fireEvent.click(screen.getByRole('button', { name: 'oauth-flow' }));
    expect(deploy.startRuns).toHaveBeenCalledTimes(2);
  });

  it('links to the app installations on a permissions error', () => {
    const { emit, openExternal } = setup();
    emit(base({ runs: [], selected: undefined, error: { kind: 'permissions', message: '' } }));
    expect(screen.getByText('deploy:errors.permissions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deploy:errors.manageAccess' }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/settings/installations');
  });

  it('says until when it is paused on a rate limit', () => {
    const { emit } = setup();
    const resetAt = new Date(2026, 10, 11, 14, 5).toISOString();
    emit(base({ error: { kind: 'rate-limit', resetAt, message: '' } }));
    expect(screen.getByText('deploy:errors.rate-limit {"time":"14:05"}')).toBeInTheDocument();
    // runs already known stay on screen
    expect(screen.getByText('Merge task 17')).toBeInTheDocument();
  });

  it('says GitHub is not responding', () => {
    const { emit } = setup();
    emit(base({ error: { kind: 'unavailable', message: '' } }));
    expect(screen.getByText('deploy:errors.unavailable')).toBeInTheDocument();
  });

  it('does not resend a log request that is still in flight when a poll arrives', async () => {
    const { deploy, emit } = setup();
    let resolve: (v: unknown) => void = () => undefined;
    deploy.jobLog.mockImplementation(() => new Promise((r) => { resolve = r as (v: unknown) => void; }) as never);
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    await waitFor(() => expect(deploy.jobLog).toHaveBeenCalledTimes(1));
    emit(base({ nextPollAt: '2026-11-11T10:06:05Z' }));
    emit(base({ nextPollAt: '2026-11-11T10:06:10Z' }));
    await act(async () => resolve({ success: true, data: { state: 'ready', text: 'big log' } }));
    expect(await screen.findByText(/big log/)).toBeInTheDocument();
    expect(deploy.jobLog).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a ready log again on the next poll', async () => {
    const { deploy, emit } = setup({ state: 'ready', text: 'line one' });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    expect(await screen.findByText(/line one/)).toBeInTheDocument();
    emit(base({ nextPollAt: '2026-11-11T10:06:05Z' }));
    await act(async () => undefined);
    expect(deploy.jobLog).toHaveBeenCalledTimes(1);
  });

  it('asks again for a log GitHub is still preparing on the next poll, and says so', async () => {
    const { deploy, emit } = setup({ state: 'pending' });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    expect(await screen.findByText('deploy:log.preparing')).toBeInTheDocument();
    expect(deploy.jobLog).toHaveBeenCalledTimes(1);
    emit(base({ nextPollAt: '2026-11-11T10:06:05Z' }));
    await waitFor(() => expect(deploy.jobLog).toHaveBeenCalledTimes(2));
  });

  it('asks again for a rate-limited log on a poll once the limit has reset', async () => {
    const resetAt = new Date(Date.now() - 1_000).toISOString();
    const { deploy, emit } = setup({ state: 'error', error: { kind: 'rate-limit', resetAt, message: '' } });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    await waitFor(() => expect(deploy.jobLog).toHaveBeenCalledTimes(1));
    emit(base({ nextPollAt: '2026-11-11T10:06:05Z' }));
    await waitFor(() => expect(deploy.jobLog).toHaveBeenCalledTimes(2));
  });

  it('does not ask again for a rate-limited log before the limit resets', async () => {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const { deploy, emit } = setup({ state: 'error', error: { kind: 'rate-limit', resetAt, message: '' } });
    emit(base());
    fireEvent.click(screen.getByRole('button', { name: /^typecheck/ }));
    await waitFor(() => expect(deploy.jobLog).toHaveBeenCalledTimes(1));
    emit(base({ nextPollAt: '2026-11-11T10:06:05Z' }));
    await act(async () => undefined);
    expect(deploy.jobLog).toHaveBeenCalledTimes(1);
  });

  it('links to the app installations when the repository is not found (a private repo the app cannot reach)', () => {
    const { emit, openExternal } = setup();
    emit(base({ runs: [], selected: undefined, error: { kind: 'not-found', message: '' } }));
    expect(screen.getByText('deploy:errors.not-found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deploy:errors.manageAccess' }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/settings/installations');
  });

  it('links to the install page when the repository is not found and the app is not installed on its owner', async () => {
    const { emit, openExternal, getGitHubAppAccess } = setup();
    getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: false, repoReachable: false } });
    emit(base({ runs: [], selected: undefined, error: { kind: 'not-found', message: '' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'deploy:errors.installApp' }));
    expect(getGitHubAppAccess).toHaveBeenCalledWith('acme/app');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/apps/vibe-teamlead-app/installations/new');
    expect(screen.queryByRole('button', { name: 'deploy:errors.manageAccess' })).not.toBeInTheDocument();
  });

  it('keeps "manage access" on not-found when the installation cannot be checked', async () => {
    const { emit, getGitHubAppAccess } = setup();
    getGitHubAppAccess.mockResolvedValue({ success: false, error: 'offline' } as never);
    emit(base({ runs: [], selected: undefined, error: { kind: 'not-found', message: '' } }));
    await waitFor(() => expect(getGitHubAppAccess).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'deploy:errors.manageAccess' })).toBeInTheDocument();
  });

  it('shows no link for a URL that is not http(s), and survives a failed openExternal', async () => {
    const { emit, openExternal } = setup();
    openExternal.mockImplementation(async () => { throw new Error('nope'); });
    const g: RunGraph = { columns: [{ stage: 'deploy', nodes: [{ key: 'd', label: 'production', jobIds: [], status: 'success', deploymentUrl: 'javascript:alert(1)', logUrl: 'https://vercel.com/log' }] }] };
    emit(base({ productionUrl: 'file:///etc/passwd', selected: { runId: 18, jobs, graph: g } }));
    expect(screen.queryByText('/etc/passwd')).not.toBeInTheDocument();
    expect(screen.queryByText('file:///etc/passwd')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^production/ }));
    expect(screen.queryByText(/alert/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deploy:job.deploymentLog' }));
    await act(async () => undefined);
    expect(openExternal).toHaveBeenCalledWith('https://vercel.com/log');
  });

  it('says it is paused instead of loading when a run is picked during a rate limit', () => {
    const { emit } = setup();
    emit(base({ error: { kind: 'rate-limit', resetAt: new Date(2026, 10, 11, 14, 5).toISOString(), message: '' } }));
    fireEvent.click(screen.getByText('Merge task 17'));
    expect(screen.queryByText('deploy:graph.loading')).not.toBeInTheDocument();
    expect(screen.getByText('deploy:graph.paused')).toBeInTheDocument();
  });

  it('hides the number when GitHub gave none', () => {
    const { emit } = setup();
    emit(base({ runs: [run(18, { number: 0 })] }));
    expect(screen.getByRole('heading', { name: 'Merge task 18' })).toBeInTheDocument();
    expect(screen.queryByText(/#0/)).not.toBeInTheDocument();
  });

  it('stops polling while the window is hidden and on unmount', () => {
    const { deploy, emit, view, unsubscribe } = setup();
    emit(base());
    fireEvent.click(screen.getByText('Merge task 17'));
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(deploy.stopRuns).toHaveBeenCalledWith('p1');
    hidden.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(deploy.startRuns).toHaveBeenLastCalledWith('p1', 17);
    hidden.mockRestore();
    deploy.stopRuns.mockClear();
    view.unmount();
    expect(deploy.stopRuns).toHaveBeenCalledWith('p1');
    expect(unsubscribe).toHaveBeenCalled();
  });
});
