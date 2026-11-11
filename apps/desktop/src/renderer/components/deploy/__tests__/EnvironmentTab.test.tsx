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
  VercelStatus,
} from '../../../../shared/types/deploy';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../project-settings/GitHubOAuthFlow', () => ({ GitHubOAuthFlow: () => <p>github-oauth-flow</p> }));

import { DeployPage } from '../DeployPage';
import { APP_SECTIONS } from '../../settings/AppSettings';

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
  vercel: { projectId: 'prj_1', projectName: 'shop', teamId: 'team_1' },
  setUpAt: '2026-11-11T10:00:00Z',
};

interface Opts {
  env?: Partial<DeployEnvState>;
  vercel?: VercelStatus;
  setUp?: (projectId: string, opts?: unknown) => Promise<unknown>;
  variables?: unknown;
}

function setup(opts: Opts = {}) {
  let progress: ((p: DeploySetupProgress) => void) | undefined;
  let pushResult: ((r: DeployPushResult) => void) | undefined;
  let runsUpdate: ((s: DeployRunsState) => void) | undefined;
  const env: DeployEnvState = { settings: null, setupRunning: false, databaseRunning: false, ...opts.env };
  const deploy = {
    startRuns: vi.fn(async () => ({ success: true })),
    selectRun: vi.fn(async () => ({ success: true })),
    stopRuns: vi.fn(async () => ({ success: true })),
    jobLog: vi.fn(async () => ({ success: true, data: { state: 'pending' } })),
    onRunsUpdate: vi.fn((cb: (s: DeployRunsState) => void) => { runsUpdate = cb; return () => undefined; }),
    state: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: env })),
    setUp: vi.fn(opts.setUp ?? (async () => ({ success: true, data: { settings: setUpSettings, needed: [], step: 'done' } }))),
    chooseVercelProject: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: { settings: setUpSettings, needed: [], step: 'done' } })),
    setVariable: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: { ok: true, vercel: 'ok', github: 'skipped' } })),
    listVariables: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: opts.variables ?? { ok: true, variables: [] } })),
    addDatabase: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, data: { ok: true } })),
    onSetupProgress: vi.fn((cb: (p: DeploySetupProgress) => void) => { progress = cb; return () => undefined; }),
    onPushResult: vi.fn((cb: (r: DeployPushResult) => void) => { pushResult = cb; return () => undefined; }),
  };
  const vercel = {
    status: vi.fn(async () => ({ success: true, data: opts.vercel ?? { connected: true, user: { id: 'u1', username: 'ada' }, teams: [] } })),
  };
  const openExternal = vi.fn(async () => undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = { deploy, vercel, openExternal, getGitHubAppAccess: vi.fn(async () => ({ success: false })) };
  render(<DeployPage projectId="p1" />);
  return {
    deploy,
    vercel,
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
  lastSetup: { settings: { enabled: false }, needed: items, step: 'vercel', ...over },
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
    await waitFor(() => expect(deploy.setUp).toHaveBeenCalledWith('p1', undefined));
    await waitFor(() => expect(deploy.startRuns).toHaveBeenCalled());
  });

  it('with Vercel teams, offers personal or a team before setup and passes the choice', async () => {
    const { deploy } = setup({ vercel: { connected: true, user: { id: 'u1', username: 'ada' }, teams: [{ id: 'team_1', slug: 'acme', name: 'Acme' }] } });
    const panel = await openEnvironment();
    const team = await within(panel).findByRole('button', { name: 'Acme' });
    expect(within(panel).getByRole('button', { name: 'deploy:setup.personal {"name":"ada"}' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(team);
    expect(team).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:setup.start' }));
    await waitFor(() => expect(deploy.setUp).toHaveBeenCalledWith('p1', { vercelTeamId: 'team_1' }));
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
    expect(mark('deploy:setup.step.vercel')).toBe('queued');
    expect(within(panel).getByRole('button', { name: 'deploy:setup.running' })).toBeDisabled();
    await act(async () => finish({ success: true, data: { settings: setUpSettings, needed: [], step: 'done' } }));
  });

  it('a setup error shows its kind in words, never main’s English message', async () => {
    setup({ env: needed([], { error: { kind: 'bad-request', message: 'RAW ENGLISH FROM MAIN' } }) });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:env.errors.bad-request')).toBeInTheDocument();
    expect(within(panel).queryByText(/RAW ENGLISH/)).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'deploy:setup.retry' })).toBeInTheDocument();
  });
});

describe('Needed from you', () => {
  it('Connect Vercel opens the Vercel section of Settings (a real section)', async () => {
    setup({ env: needed([{ id: 'vercel-sign-in', kind: 'vercel-sign-in', message: 'm' }]) });
    const sections: unknown[] = [];
    const listener = (e: Event) => sections.push((e as CustomEvent).detail);
    window.addEventListener('open-app-settings', listener);
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:needed.vercel-sign-in')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:needed.actions.connectVercel' }));
    window.removeEventListener('open-app-settings', listener);
    expect(sections).toEqual(['vercel']);
    expect(APP_SECTIONS).toContain(sections[0]);
  });

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
    setup({ env: needed([{ id: 'vercel-git-access', kind: 'vercel-git-access', message: 'm' }]) });
    const panel = await openEnvironment();
    const steps = await within(panel).findByRole('list', { name: 'deploy:setup.steps' });
    const mark = (name: string) => within(steps).getByText(name).closest('li')?.querySelector('[data-marker]')?.getAttribute('data-marker');
    expect(mark('deploy:setup.step.repo')).toBe('success');
    expect(mark('deploy:setup.step.vercel')).toBe('attention');
    expect(within(steps).getByText('deploy:status.attention')).toBeInTheDocument();
  });

  it('Personal has no empty parentheses when the username is unknown', async () => {
    setup({ vercel: { connected: true, user: { username: '' }, teams: [{ id: 'team_1', slug: 'acme', name: 'Acme' }] } });
    const panel = await openEnvironment();
    expect(await within(panel).findByRole('button', { name: 'deploy:setup.personalNoName' })).toBeInTheDocument();
  });

  it('Install app, Grant Vercel access and the dashboard open their links', async () => {
    const h = setup({ env: {
      ...needed([
        { id: 'github-app-install', kind: 'github-app-install', message: 'm', actionUrl: 'https://github.com/apps/vibe/installations/new' },
        { id: 'vercel-git-access', kind: 'vercel-git-access', message: 'm', actionUrl: 'https://github.com/apps/vercel/installations/new' },
      ]),
      lastDatabase: { ok: false, needed: { id: 'database-dashboard', kind: 'database-dashboard', message: 'm', actionUrl: 'https://vercel.com/acme/shop/stores' } },
    } });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:needed.actions.installApp' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:needed.actions.grantVercel' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:needed.actions.openDashboard' }));
    expect(h.openExternal.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'https://github.com/apps/vibe/installations/new',
      'https://github.com/apps/vercel/installations/new',
      'https://vercel.com/acme/shop/stores',
    ]);
  });

  it('an existing Vercel project: use it, or create a new one', async () => {
    const h = setup({ env: needed([{
      id: 'vercel-existing-project', kind: 'vercel-existing-project', message: 'm',
      projects: [{ id: 'prj_a', name: 'shop' }, { id: 'prj_b', name: 'shop-old' }],
    }]) });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:needed.actions.useProject {"name":"shop-old"}' }));
    await waitFor(() => expect(h.deploy.chooseVercelProject).toHaveBeenCalledWith('p1', { useProjectId: 'prj_b' }));
  });

  it('create a new Vercel project instead', async () => {
    const h = setup({ env: needed([{ id: 'vercel-existing-project', kind: 'vercel-existing-project', message: 'm', projects: [{ id: 'prj_a', name: 'shop' }] }]) });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:needed.actions.createNew' }));
    await waitFor(() => expect(h.deploy.chooseVercelProject).toHaveBeenCalledWith('p1', { createNew: true }));
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

  it('a missing variable opens the dialog with its name', async () => {
    setup({ env: { settings: setUpSettings, lastSetup: { settings: setUpSettings, needed: [{ id: 'v', kind: 'variable', message: 'm', variable: 'DATABASE_URL' }], step: 'done' } } });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:needed.actions.addValue' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('deploy:variableDialog.name')).toHaveValue('DATABASE_URL');
    fireEvent.change(within(dialog).getByLabelText('deploy:variableDialog.value'), { target: { value: 'postgres://x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:variableDialog.save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // saved: no longer needed, without running setup again
    expect(within(panel).queryByText('deploy:needed.variable {"name":"DATABASE_URL"}')).not.toBeInTheDocument();
  });

  it('database terms: the integration, each policy link with its host, and Accept and add database', async () => {
    let finish!: (v: unknown) => void;
    const h = setup({ env: {
      settings: setUpSettings,
      lastDatabase: { ok: false, needed: {
        id: 'database-terms', kind: 'database-terms', message: 'm', integration: 'neon',
        policyLinks: [
          { name: 'Privacy Policy', url: 'https://neon.tech/privacy', host: 'neon.tech' },
          { name: 'Terms', url: 'https://evil.example/terms', host: 'evil.example' },
          { name: 'Plain', url: 'http://neon.tech/plain', host: 'neon.tech' },
        ],
      } },
    } });
    h.deploy.addDatabase.mockImplementation(() => new Promise((r) => { finish = r; }));
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:needed.database-terms {"integration":"Neon"}')).toBeInTheDocument();
    expect(within(panel).getByText('evil.example')).toBeInTheDocument();
    expect(within(panel).getAllByText('neon.tech').length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Terms' }));
    expect(h.openExternal).toHaveBeenCalledWith('https://evil.example/terms');
    // not https: shown, never a link
    expect(within(panel).queryByRole('button', { name: 'Plain' })).not.toBeInTheDocument();
    const accept = within(panel).getByRole('button', { name: 'deploy:needed.actions.acceptTerms' });
    fireEvent.click(accept);
    expect(h.deploy.addDatabase).toHaveBeenCalledWith('p1', { acceptTerms: true });
    await waitFor(() => expect(accept).toBeDisabled());
    fireEvent.click(accept);
    expect(h.deploy.addDatabase).toHaveBeenCalledTimes(1);
    await act(async () => finish({ success: true, data: { ok: true } }));
  });
});

describe('What exists', () => {
  it('repository with visibility, Vercel project, production URL and database', async () => {
    const h = setup({
      env: { settings: { ...setUpSettings, database: { provider: 'neon', addedAt: '2026-11-11T10:00:00Z' } } },
      vercel: { connected: true, user: { id: 'u1', username: 'ada' }, teams: [{ id: 'team_1', slug: 'acme-team', name: 'Acme' }] },
    });
    h.runs({ projectId: 'p1', repo: { owner: 'acme', repo: 'shop' }, runs: [], productionUrl: 'https://shop.vercel.app', nextPollAt: '2026-11-11T10:06:00Z' });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'shop.vercel.app' }));
    h.openExternal.mockClear();
    fireEvent.click(await within(panel).findByRole('button', { name: 'acme/shop' }));
    expect(within(panel).getByText('deploy:exists.private')).toBeInTheDocument();
    fireEvent.click(await within(panel).findByRole('button', { name: 'shop' }));
    expect(within(panel).getByText('deploy:database.neon')).toBeInTheDocument();
    expect(h.openExternal.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['https://github.com/acme/shop', 'https://vercel.com/acme-team/shop']);
  });
});

describe('Variables', () => {
  it('lists names, targets and the GitHub mark', async () => {
    setup({ env: { settings: setUpSettings }, variables: { ok: true, variables: [
      { name: 'API_KEY', targets: ['production', 'preview'], inGitHub: true },
      { name: 'DEBUG', targets: ['preview'], inGitHub: false },
    ] } });
    const panel = await openEnvironment();
    const row = (await within(panel).findByText('API_KEY')).closest('li') as HTMLElement;
    expect(within(row).getByText('deploy:variables.target.production')).toBeInTheDocument();
    expect(within(row).getByText('deploy:variables.target.preview')).toBeInTheDocument();
    expect(within(row).getByText('deploy:variables.inGitHub')).toBeInTheDocument();
    const other = within(panel).getByText('DEBUG').closest('li') as HTMLElement;
    expect(within(other).queryByText('deploy:variables.inGitHub')).not.toBeInTheDocument();
  });

  it('saving calls setVariable; afterwards the list shows the name and the value is gone from the DOM', async () => {
    const h = setup({ env: { settings: setUpSettings } });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:variables.add' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('deploy:variableDialog.name'), { target: { value: 'API_KEY' } });
    const value = within(dialog).getByLabelText('deploy:variableDialog.value');
    expect(value).toHaveAttribute('type', 'password');
    fireEvent.change(value, { target: { value: 'sk_live_TOPSECRET' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'deploy:variableDialog.preview' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'deploy:variableDialog.alsoGitHub' }));
    h.deploy.setVariable.mockResolvedValueOnce({ success: true, data: { ok: true, vercel: 'ok', github: 'ok' } });
    h.deploy.listVariables.mockResolvedValueOnce({ success: true, data: { ok: true, variables: [{ name: 'API_KEY', targets: ['production'], inGitHub: true }] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:variableDialog.save' }));
    await waitFor(() => expect(h.deploy.setVariable).toHaveBeenCalledWith('p1', { name: 'API_KEY', value: 'sk_live_TOPSECRET', targets: ['production'], alsoGitHubSecret: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(panel).findByText('API_KEY')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('sk_live_TOPSECRET');
  });

  it('shows each side’s result: Vercel saved, GitHub failed', async () => {
    const h = setup({ env: { settings: setUpSettings } });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:variables.add' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('deploy:variableDialog.name'), { target: { value: 'API_KEY' } });
    fireEvent.change(within(dialog).getByLabelText('deploy:variableDialog.value'), { target: { value: 'v4lue' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'deploy:variableDialog.alsoGitHub' }));
    h.deploy.setVariable.mockResolvedValueOnce({ success: true, data: { ok: false, vercel: 'ok', github: { kind: 'permissions', message: 'RAW' } } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:variableDialog.save' }));
    expect(await within(dialog).findByText('deploy:variableDialog.result.vercel.ok')).toBeInTheDocument();
    expect(within(dialog).getByText('deploy:variableDialog.result.github.failed {"reason":"deploy:env.errors.permissions"}')).toBeInTheDocument();
    expect(within(dialog).queryByText('RAW')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('v4lue');
  });

  it('cancel drops the typed value: reopening shows an empty field and the DOM never keeps it', async () => {
    setup({ env: { settings: setUpSettings } });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:variables.add' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('deploy:variableDialog.value'), { target: { value: 'typed_SECRET' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'deploy:variableDialog.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain('typed_SECRET');
    fireEvent.click(within(panel).getByRole('button', { name: 'deploy:variables.add' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('deploy:variableDialog.value')).toHaveValue('');
  });

  it('a list failure shows its kind', async () => {
    setup({ env: { settings: setUpSettings }, variables: { ok: false, kind: 'forbidden', message: 'RAW' } });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:env.errors.forbidden')).toBeInTheDocument();
  });
});

describe('Database', () => {
  it('Add database calls addDatabase and shows the terms it returns', async () => {
    const h = setup({ env: { settings: setUpSettings } });
    h.deploy.addDatabase.mockResolvedValueOnce({ success: true, data: { ok: false, needed: { id: 'database-terms', kind: 'database-terms', message: 'm', integration: 'neon', policyLinks: [] } } });
    h.deploy.state.mockResolvedValue({ success: true, data: { settings: setUpSettings, setupRunning: false, databaseRunning: false, lastDatabase: { ok: false, needed: { id: 'database-terms', kind: 'database-terms', message: 'm', integration: 'neon', policyLinks: [] } } } });
    const panel = await openEnvironment();
    fireEvent.click(await within(panel).findByRole('button', { name: 'deploy:database.add' }));
    expect(h.deploy.addDatabase).toHaveBeenCalledWith('p1', undefined);
    expect(await within(panel).findByText('deploy:needed.database-terms {"integration":"Neon"}')).toBeInTheDocument();
  });

  it('a database error shows its kind', async () => {
    setup({ env: { settings: setUpSettings, lastDatabase: { ok: false, error: { kind: 'saved-failed', message: 'RAW' } } } });
    const panel = await openEnvironment();
    expect(await within(panel).findByText('deploy:env.errors.saved-failed')).toBeInTheDocument();
  });
});

describe('Push after merge', () => {
  it('shows the last failed push, and a new result as it arrives', async () => {
    const h = setup({ env: { settings: setUpSettings, lastPush: { projectId: 'p1', ok: false, error: { kind: 'permissions', message: 'RAW' }, at: '2026-11-11T10:00:00Z' } } });
    const panel = await openEnvironment();
    expect(await within(panel).findByText(/^deploy:push\.failed/)).toHaveTextContent('deploy:env.errors.permissions');
    h.push({ projectId: 'p1', ok: true, at: '2026-11-11T11:00:00Z' });
    expect(await within(panel).findByText(/^deploy:push\.ok/)).toBeInTheDocument();
    expect(within(panel).queryByText(/^deploy:push\.failed/)).not.toBeInTheDocument();
  });
});
