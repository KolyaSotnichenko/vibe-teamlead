/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { DeployChecklist } from '../DeployChecklist';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

interface Opts {
  github?: boolean;
  app?: boolean;
  vercel?: boolean;
  setUp?: boolean;
}

function setup({ github = true, app = true, vercel = true, setUp = false }: Opts = {}) {
  const api = {
    checkGitHubAuth: vi.fn(async () => ({ success: true, data: { authenticated: github } })),
    getGitHubAppAccess: vi.fn(async () => (github ? { success: true, data: { installed: app } } : { success: false, error: 'Not signed in' })),
    vercel: { status: vi.fn(async () => ({ success: true, data: { connected: vercel } })) },
    openExternal: vi.fn(async () => undefined),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  const onConnectGitHub = vi.fn();
  const onSetUp = vi.fn();
  render(<DeployChecklist setUp={setUp} onConnectGitHub={onConnectGitHub} onSetUp={onSetUp} />);
  return { api, onConnectGitHub, onSetUp };
}

const list = () => screen.findByRole('list', { name: 'deploy:checklist.title' });
const item = (l: HTMLElement, key: string) => within(l).getByText(`deploy:checklist.${key}`).closest('li') as HTMLElement;
const mark = (li: HTMLElement) => li.querySelector('[data-marker]')?.getAttribute('data-marker');

describe('DeployChecklist', () => {
  it('lists what is missing, in order, with the first open step to act on', async () => {
    const h = setup({ github: false, vercel: false });
    const l = await list();
    await waitFor(() => expect(mark(item(l, 'github'))).toBe('attention'));
    const names = within(l).getAllByRole('listitem').map((li) => li.textContent);
    expect(names[0]).toContain('deploy:checklist.github');
    expect(names[1]).toContain('deploy:checklist.app');
    expect(names[2]).toContain('deploy:checklist.vercel');
    expect(names[3]).toContain('deploy:checklist.setUp');
    fireEvent.click(within(item(l, 'github')).getByRole('button', { name: 'deploy:checklist.actions.github' }));
    expect(h.onConnectGitHub).toHaveBeenCalled();
    // installing the app needs the GitHub sign-in first
    expect(within(item(l, 'app')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('done steps are ticked; Connect Vercel opens Settings → Vercel', async () => {
    setup({ vercel: false });
    const l = await list();
    await waitFor(() => expect(mark(item(l, 'github'))).toBe('success'));
    expect(mark(item(l, 'app'))).toBe('success');
    const sections: unknown[] = [];
    const listener = (e: Event) => sections.push((e as CustomEvent).detail);
    window.addEventListener('open-app-settings', listener);
    fireEvent.click(within(item(l, 'vercel')).getByRole('button', { name: 'deploy:checklist.actions.vercel' }));
    window.removeEventListener('open-app-settings', listener);
    expect(sections).toEqual(['vercel']);
  });

  it('Install the app opens the GitHub App install page', async () => {
    const h = setup({ app: false });
    const l = await list();
    const btn = await within(item(l, 'app')).findByRole('button', { name: 'deploy:checklist.actions.app' });
    fireEvent.click(btn);
    expect(h.api.openExternal).toHaveBeenCalledWith(expect.stringContaining('github.com/apps/'));
  });

  it('accounts ready: the last step leads to Set up deploy', async () => {
    const h = setup();
    const l = await list();
    const btn = await within(item(l, 'setUp')).findByRole('button', { name: 'deploy:setup.cta' });
    fireEvent.click(btn);
    expect(h.onSetUp).toHaveBeenCalled();
  });

  it('everything done: nothing is shown', async () => {
    const h = setup({ setUp: true });
    await waitFor(() => expect(h.api.vercel.status).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole('list', { name: 'deploy:checklist.title' })).not.toBeInTheDocument();
  });

  it('coming back to the app reads the accounts again', async () => {
    const h = setup({ vercel: false });
    const l = await list();
    await waitFor(() => expect(mark(item(l, 'vercel'))).toBe('attention'));
    h.api.vercel.status.mockResolvedValue({ success: true, data: { connected: true } });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mark(item(l, 'vercel'))).toBe('success'));
  });
});
