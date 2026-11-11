/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppInstallStep, GitHubRepoAccessNotice } from '../GitHubAppInstallStep';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

const api = {
  getGitHubAppAccess: vi.fn(),
  openExternal: vi.fn(async () => undefined),
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitHubAppInstallStep', () => {
  it('continues at once when the app is installed', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: true, repositorySelection: 'all' } });
    const onInstalled = vi.fn();
    render(<GitHubAppInstallStep onInstalled={onInstalled} />);
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('dialogs:githubAppAccess.title')).not.toBeInTheDocument();
  });

  it('asks to install the app when it is not installed, and opens the install page', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: false } });
    const onInstalled = vi.fn();
    render(<GitHubAppInstallStep onInstalled={onInstalled} />);
    expect(await screen.findByText('dialogs:githubAppAccess.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.install' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/apps/vibe-teamlead-app/installations/new');
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('continues after "check again" once the app is installed', async () => {
    api.getGitHubAppAccess.mockResolvedValueOnce({ success: true, data: { installed: false } });
    const onInstalled = vi.fn();
    render(<GitHubAppInstallStep onInstalled={onInstalled} />);
    const again = await screen.findByRole('button', { name: 'dialogs:githubAppAccess.checkAgain' });
    api.getGitHubAppAccess.mockResolvedValueOnce({ success: true, data: { installed: false } });
    fireEvent.click(again);
    expect(await screen.findByText('dialogs:githubAppAccess.stillMissing')).toBeInTheDocument();
    api.getGitHubAppAccess.mockResolvedValueOnce({ success: true, data: { installed: true, repositorySelection: 'selected' } });
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.checkAgain' }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
  });

  it('checks again when the window regains focus', async () => {
    api.getGitHubAppAccess.mockResolvedValueOnce({ success: true, data: { installed: false } });
    const onInstalled = vi.fn();
    render(<GitHubAppInstallStep onInstalled={onInstalled} />);
    await screen.findByText('dialogs:githubAppAccess.title');
    api.getGitHubAppAccess.mockResolvedValueOnce({ success: true, data: { installed: true, repositorySelection: 'all' } });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
  });

  it('shows a generic message (not "not installed") when the check fails', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: false, error: 'GitHub returned HTTP 500' });
    render(<GitHubAppInstallStep onInstalled={vi.fn()} />);
    expect(await screen.findByText('dialogs:githubAppAccess.error')).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument();
    expect(screen.queryByText('dialogs:githubAppAccess.title')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dialogs:githubAppAccess.checkAgain' })).toBeInTheDocument();
  });
});

describe('GitHubRepoAccessNotice', () => {
  it('asks to add the repository when the app is on selected repositories only', () => {
    const onCheckAgain = vi.fn();
    render(
      <GitHubRepoAccessNotice
        repo="acme/app"
        access={{ installed: true, repositorySelection: 'selected', repoReachable: false }}
        onCheckAgain={onCheckAgain}
      />
    );
    expect(screen.getByText('dialogs:githubAppAccess.repoTitle {"repo":"acme/app"}')).toBeInTheDocument();
    expect(screen.getByText('dialogs:githubAppAccess.repoSelected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.addRepo' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/settings/installations');
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.checkAgainShort' }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  it('asks to install the app when it is not installed on the owner', () => {
    render(<GitHubRepoAccessNotice repo="acme/app" access={{ installed: false, repoReachable: false }} onCheckAgain={vi.fn()} />);
    expect(screen.getByText('dialogs:githubAppAccess.repoNotInstalled {"owner":"acme"}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.installApp' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/apps/vibe-teamlead-app/installations/new');
  });

  it('falls back to "manage access" when it cannot tell', () => {
    render(<GitHubRepoAccessNotice repo="acme/app" access={null} onCheckAgain={vi.fn()} />);
    expect(screen.getByText('dialogs:githubAppAccess.repoUnknown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.manageAccess' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/settings/installations');
  });
});
