/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  DeployEnvState,
  DeployProjectSettings,
  DeployPushResult,
  DeployRunsState,
  DeploySetupProgress,
  DeploySetupState,
  NeededFromYou,
} from '../../../../shared/types/deploy';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../project-settings/GitHubOAuthFlow', () => ({ GitHubOAuthFlow: () => <p>github-oauth-flow</p> }));

import { DeployPage } from '../DeployPage';

// Radix (checkbox) measures itself; jsdom has no ResizeObserver
const noop = () => undefined;
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const setUpSettings: DeployProjectSettings = {
  enabled: true,
  repo: { owner: 'acme', repo: 'shop', createdByApp: true, public: false },
  setUpAt: '2026-11-11T10:00:00Z',
};

interface Opts {
  env?: Partial<DeployEnvState>;
  setUp?: (projectId: string) => Promise<unknown>;
  secrets?: string[];
}

function setup(opts: Opts = {}) {
  let progress: ((p: DeploySetupProgress) => void) | undefined;
  let pushResult: ((r: DeployPushResult) => void) | undefined;
  let runsUpdate: ((s: DeployRunsState) => void) | undefined;
  const env: DeployEnvState = { settings: null, setupRunning: false, ...opts.env };
  const deploy = {
    startRuns: vi.fn(async () => ({ success: true })),
    selectRun: vi.fn(async () => ({ success: true })),
    stopRuns: vi.fn(async () => ({ success: true })),
    jobLog: vi.fn(async () => ({ success: true, data: { state: 'pending' } })),
    onRunsUpdate: vi.fn((cb: (s: DeployRunsState) => void) => { runsUpdate = cb; return () => undefined; }),
    state: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: env })),
    setUp: vi.fn(opts.setUp ?? (async () => ({ success: true, data: { settings: setUpSettings, needed: [], step: 'done' } }))),
    readinessState: vi.fn(async () => ({ success: true, data: { scanning: false, tasks: {} } })),
    onReadinessUpdate: vi.fn(() => () => undefined),
    onSetupProgress: vi.fn((cb: (p: DeploySetupProgress) => void) => { progress = cb; return () => undefined; }),
    listSecrets: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: { ok: true, names: opts.secrets ?? [] } })),
    setSecret: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: { ok: true } })),
    onPushResult: vi.fn((cb: (r: DeployPushResult) => void) => { pushResult = cb; return () => undefined; }),
  };
  const openExternal = vi.fn(async () => undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = { deploy, openExternal, getGitHubAppAccess: vi.fn(async () => ({ success: false })) };
  render(<DeployPage projectId="p1" />);
  return {
    deploy,
    openExternal,
    progress: (step: DeploySetupProgress['step']) => act(() => progress?.({ projectId: 'p1', step })),
    push: (r: DeployPushResult) => act(() => pushResult?.(r)),
    runs: (r: DeployRunsState) => act(() => runsUpdate?.(r)),
  };
}

const openEnvironment = async () => {
  fireEvent.click(await screen.findByRole('tab', { name: 'deploy:tabs.environment' }));
  return screen.findByRole('tabpanel');
};

const needed = (items: NeededFromYou[], over: Partial<DeploySetupState> = {}): Partial<DeployEnvState> => ({
  settings: { enabled: false, repo: { owner: 'acme', repo: 'shop', createdByApp: false, public: true } },
  lastSetup: { settings: { enabled: false }, needed: items, step: 'repo', ...over },
});

describe('Set up deploy', () => {
  it('not set up: Runs offers Set up deploy, which leads to the Environment tab', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'deploy:setup.cta' }));
    expect(screen.getByRole('tab', { name: 'deploy:tabs.environment' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: 'deploy:setup.start' })).toBeInTheDocument();
  });

  it('set up: no call to action on Runs', async () => {
    const { deploy } = setup({ env: { settings: setUpSettings } });
    await waitFor(() => expect(deploy.state).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'deploy:setup.cta' })).not.toBeInTheDocument();
  });

  it('Set up deploy calls deploy.setUp, and the runs restart when it is done', async () => {
    const { deploy } = setup();
    await openEnvironment();
    deploy.startRuns.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'deploy:setup.start' }));
    await waitFor(() => expect(deploy.setUp).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(deploy.startRuns).toHaveBeenCalled());
  });

  it('no Vercel: the steps are repository, push and done only, with no team choice', async () => {
    const h = setup({ setUp: () => new Promise(() => undefined) });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:setup.start' }));
    h.progress('repo');
    const steps = await within(panel).findByRole('list', { name: 'deploy:setup.steps' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('deploy:setup.step.repo'),
      expect.stringContaining('deploy:setup.step.push'),
      expect.stringContaining('deploy:setup.step.done'),
    ]);
    expect(within(panel).queryByText(/vercel/i)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /personal/ })).not.toBeInTheDocument();
  });

  it('shows the steps while setup runs, and disables the button', async () => {
    let finish!: (v: unknown) => void;
    const h = setup({ setUp: () => new Promise((r) => { finish = r; }) });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:setup.start' }));
    h.progress('push');
    const steps = await within(panel).findByRole('list', { name: 'deploy:setup.steps' });
    const mark = (name: string) => within(steps).getByText(name).closest('li')?.querySelector('[data-marker]')?.getAttribute('data-marker');
    expect(mark('deploy:setup.step.repo')).toBe('success');
    expect(mark('deploy:setup.step.push')).toBe('running');
    expect(mark('deploy:setup.step.done')).toBe('queued');
    expect(within(panel).getByRole('button', { name: 'deploy:setup.running' })).toBeDisabled();
    await act(async () => finish({ success: true, data: { settings: setUpSettings, needed: [], step: 'done' } }));
  });

  it('a setup error shows its kind in words, never main’s English message', async () => {
    setup({ env: needed([], { error: { kind: 'permissions', message: 'RAW ENGLISH FROM MAIN' } }) });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:env.errors.permissions')).toBeInTheDocument();
    expect(within(panel).queryByText(/RAW ENGLISH/)).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'deploy:setup.retry' })).toBeInTheDocument();
  });
});

describe('Needed from you', () => {
  it('Connect GitHub opens the GitHub sign-in dialog, not Settings', async () => {
    setup({ env: needed([{ id: 'github-sign-in', kind: 'github-sign-in', message: 'm' }]) });
    const listener = vi.fn();
    window.addEventListener('open-app-settings', listener);
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:needed.actions.connectGitHub' }));
    window.removeEventListener('open-app-settings', listener);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('deploy:signIn.title')).toBeInTheDocument();
    expect(within(dialog).getByText('github-oauth-flow')).toBeInTheDocument();
    expect(listener).not.toHaveBeenCalled();
  });

  it('a step stopped for something needed from you shows an attention mark', async () => {
    setup({ env: needed([{ id: 'github-app-install', kind: 'github-app-install', message: 'm' }]) });
    const panel = await openEnvironment();
    const steps = await within(panel).findByRole('list', { name: 'deploy:setup.steps' });
    const mark = (name: string) => within(steps).getByText(name).closest('li')?.querySelector('[data-marker]')?.getAttribute('data-marker');
    expect(mark('deploy:setup.step.repo')).toBe('attention');
    expect(mark('deploy:setup.step.done')).toBe('queued');
    expect(within(steps).getByText('deploy:status.attention')).toBeInTheDocument();
  });

  it('Install app opens its link', async () => {
    const h = setup({ env: needed([
      { id: 'github-app-install', kind: 'github-app-install', message: 'm', actionUrl: 'https://github.com/apps/vibe/installations/new' },
    ]) });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:needed.actions.installApp' }));
    expect(h.openExternal.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['https://github.com/apps/vibe/installations/new']);
  });

  it('a public repository warning can be acknowledged; a non-GitHub remote is explained', async () => {
    setup({ env: needed([
      { id: 'public-repo-warning', kind: 'public-repo-warning', message: 'm', actionUrl: 'https://github.com/acme/shop/settings' },
      { id: 'non-github-remote', kind: 'non-github-remote', message: 'm' },
    ]) });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:needed.public-repo-warning {"repo":"acme/shop"}')).toBeInTheDocument();
    expect(within(panel).getByText('deploy:needed.non-github-remote')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:needed.actions.acknowledge' }));
    expect(within(panel).queryByText('deploy:needed.public-repo-warning {"repo":"acme/shop"}')).not.toBeInTheDocument();
  });

  it('a missing secret is shown as text, with no action yet', async () => {
    setup({ env: { settings: setUpSettings, lastSetup: { settings: setUpSettings, needed: [{ id: 's', kind: 'secret', message: 'm', variable: 'API_KEY' }], step: 'done' } } });
    const panel = await openEnvironment();
    const item = (await within(panel).findByText('deploy:needed.variable {"name":"API_KEY"}')).closest('li') as HTMLElement;
    expect(within(item).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('What exists', () => {
  it('repository with visibility, no production URL; old Vercel data shows nothing of Vercel', async () => {
    const h = setup({
      env: { settings: { ...setUpSettings, vercel: { projectId: 'prj_1', projectName: 'shop-web' }, database: { provider: 'neon', addedAt: 'x' } } as DeployProjectSettings },
    });
    h.runs({ projectId: 'p1', repo: { owner: 'acme', repo: 'shop' }, runs: [], nextPollAt: '2026-11-11T10:06:00Z' });
    const panel = await openEnvironment();
    expect(within(panel).queryByText('shop.vercel.app')).not.toBeInTheDocument();
    h.openExternal.mockClear();
    fireEvent.click(await within(panel).findByRole('button', { name: 'acme/shop' }));
    expect(within(panel).getByText('deploy:exists.private')).toBeInTheDocument();
    expect(within(panel).queryByText('shop-web')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/deploy:(database|exists\.vercel|exists\.database)/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/deploy:variables/)).not.toBeInTheDocument();
    expect(h.openExternal.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['https://github.com/acme/shop']);
  });
});


describe('Push after merge', () => {
  it('shows the last failed push, and a new result as it arrives', async () => {
    const h = setup({ env: { settings: setUpSettings, lastPush: { projectId: 'p1', ok: false, error: { kind: 'permissions', message: 'RAW' }, at: '2026-11-11T10:00:00Z' } } });
    const panel = await openEnvironment();
    expect(await within(panel).findByText(/^deploy:push\.failed/)).toHaveTextContent('deploy:push.errors.permissions');
    h.push({ projectId: 'p1', ok: true, at: '2026-11-11T11:00:00Z' });
    expect(await within(panel).findByText(/^deploy:push\.ok/)).toBeInTheDocument();
    expect(within(panel).queryByText(/^deploy:push\.failed/)).not.toBeInTheDocument();
  });

  it.each([
    ['conflict', 'deploy:push.errors.conflict'],
    ['permissions', 'deploy:push.errors.permissions'],
    ['no-connection', 'deploy:push.errors.no-connection'],
    ['unavailable', 'deploy:push.errors.unavailable'],
    ['invalid', 'deploy:env.errors.invalid'],
    ['weird', 'deploy:env.errors.unknown'],
  ])('a failed push of kind %s shows %s', async (kind, text) => {
    setup({ env: { settings: setUpSettings, lastPush: { projectId: 'p1', ok: false, error: { kind, message: 'RAW' }, at: '2026-11-11T10:00:00Z' } } });
    const panel = await openEnvironment();
    const notice = await within(panel).findByText(/^deploy:push\.failed/);
    expect(notice).toHaveTextContent(text);
    expect(notice).not.toHaveTextContent('RAW');
  });
});

describe('Setup rule: a recorded repository means set up', () => {
  it('a repository recorded but setup not finished (main never reached it): Setup stays with Try again; secrets shown', async () => {
    setup({ env: { settings: { enabled: false, repo: { owner: 'acme', repo: 'shop', createdByApp: true, public: false } } } });
    const panel = await openEnvironment();
    expect(await within(panel).findByRole('button', { name: 'deploy:setup.retry' })).toBeInTheDocument();
    const steps = within(panel).getByRole('list', { name: 'deploy:setup.steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    const mark = (step: string) => within(steps).getByText(`deploy:setup.step.${step}`).closest('li')?.querySelector('[data-marker]')?.getAttribute('data-marker');
    expect(mark('repo')).toBe('success');
    expect(mark('push')).not.toBe('success');
    expect(mark('done')).not.toBe('success');
    expect(await within(panel).findByText('deploy:secrets.title')).toBeInTheDocument();
  });

  it('old data with a repository and no enabled flag (adopted repository) also offers setup again', async () => {
    setup({ env: { settings: { repo: { owner: 'acme', repo: 'shop', createdByApp: false, public: false } } as DeployProjectSettings } });
    const panel = await openEnvironment();
    expect(await within(panel).findByRole('button', { name: 'deploy:setup.retry' })).toBeInTheDocument();
  });

  it('enabled with a repository: no setup section', async () => {
    setup({ env: { settings: setUpSettings } });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:secrets.title')).toBeInTheDocument();
    expect(within(panel).queryByText('deploy:setup.title')).not.toBeInTheDocument();
  });

  it('enabled without a repository is not set up', async () => {
    setup({ env: { settings: { enabled: true } } });
    const panel = await openEnvironment();
    expect(await within(panel).findByRole('button', { name: 'deploy:setup.start' })).toBeInTheDocument();
    expect(within(panel).queryByText('deploy:secrets.title')).not.toBeInTheDocument();
  });
});

describe('Secrets', () => {
  it('not set up: no secrets section and no listing', async () => {
    const h = setup();
    const panel = await openEnvironment();
    await within(panel).findByRole('button', { name: 'deploy:setup.start' });
    expect(within(panel).queryByText('deploy:secrets.title')).not.toBeInTheDocument();
    expect(h.deploy.listSecrets).not.toHaveBeenCalled();
  });

  it('lists the names, never values', async () => {
    setup({ env: { settings: setUpSettings }, secrets: ['API_KEY', 'DB_URL'] });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('API_KEY')).toBeInTheDocument();
    expect(within(panel).getByText('DB_URL')).toBeInTheDocument();
  });

  it('none yet: says so', async () => {
    setup({ env: { settings: setUpSettings } });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:secrets.none')).toBeInTheDocument();
  });

  it('listing failed: shows the error words', async () => {
    const h = setup({ env: { settings: setUpSettings } });
    h.deploy.listSecrets.mockResolvedValue({ success: true, data: { ok: false, kind: 'permissions' } });
    cleanup();
    h.deploy.state.mockResolvedValue({ success: true, data: { settings: setUpSettings, setupRunning: false } });
    render(<DeployPage projectId="p1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'deploy:tabs.environment' }));
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('deploy:env.errors.permissions')).toBeInTheDocument();
  });

  it('adds a secret through the dialog and refreshes the list', async () => {
    const h = setup({ env: { settings: setUpSettings }, secrets: ['API_KEY'] });
    const panel = await openEnvironment();
    await within(panel).findByText('API_KEY');
    h.deploy.listSecrets.mockResolvedValue({ success: true, data: { ok: true, names: ['API_KEY', 'NEW_ONE'] } });
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:secrets.add' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('deploy:secretDialog.name'), { target: { value: 'NEW_ONE' } });
    fireEvent.change(within(dialog).getByLabelText('deploy:secretDialog.value'), { target: { value: 'hunter2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:secretDialog.save' }));
    await waitFor(() => expect(h.deploy.setSecret).toHaveBeenCalledWith('p1', 'NEW_ONE', 'hunter2'));
    expect(await within(panel).findByText('NEW_ONE')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('hunter2')).not.toBeInTheDocument();
  });

  it('replace on a name opens the dialog with that name', async () => {
    setup({ env: { settings: setUpSettings }, secrets: ['API_KEY'] });
    const panel = await openEnvironment();
    await within(panel).findByText('API_KEY');
    fireEvent.click(within(panel).getByRole('button', { name: /deploy:secrets\.replace/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('deploy:secretDialog.name')).toHaveValue('API_KEY');
  });
});
