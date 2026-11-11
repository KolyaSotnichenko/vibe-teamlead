/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

vi.mock('../settings/ClaudeCredentialPanel', () => ({ ClaudeCredentialPanel: () => <div>claude-panel</div> }));
vi.mock('../project-settings/GitHubOAuthFlow', () => ({
  GitHubOAuthFlow: ({ onSuccess }: { onSuccess: (token: string) => void }) => (
    <button type="button" onClick={() => onSuccess('ghu_x')}>oauth-flow</button>
  ),
}));

import { GitHubSetupModal } from '../GitHubSetupModal';

const api = {
  getGitHubToken: vi.fn(),
  getClaudeCredentialStatus: vi.fn(),
  detectGitHubRepo: vi.fn(),
  getGitHubBranches: vi.fn(),
  getGitHubAppAccess: vi.fn(),
  getGitHubUser: vi.fn(),
  listGitHubOrgs: vi.fn(),
  openExternal: vi.fn(async () => undefined),
};

const project = { id: 'p1', name: 'app', path: '/tmp/app' } as Project;

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  api.getGitHubToken.mockResolvedValue({ success: true, data: { token: 'ghu_x' } });
  api.getClaudeCredentialStatus.mockResolvedValue({ success: true, data: { configured: true, source: 'app' } });
  api.detectGitHubRepo.mockResolvedValue({ success: true, data: 'acme/app' });
  api.getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: true, repositorySelection: 'all' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function toBranchStep() {
  render(<GitHubSetupModal open onOpenChange={vi.fn()} project={project} onComplete={vi.fn()} onSkip={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /githubSetup.confirmAndContinue/ }));
}

describe('GitHubSetupModal: a repository the app cannot see', () => {
  it('explains access instead of the raw 404, and loads branches after "check again"', async () => {
    api.getGitHubBranches.mockResolvedValueOnce({ success: false, error: 'github:repo-not-found' });
    api.getGitHubAppAccess.mockImplementation(async (repo?: string) =>
      repo
        ? { success: true, data: { installed: true, repositorySelection: 'selected', repoReachable: false } }
        : { success: true, data: { installed: true, repositorySelection: 'selected' } }
    );
    await toBranchStep();

    expect(await screen.findByText('dialogs:githubAppAccess.repoTitle {"repo":"acme/app"}')).toBeInTheDocument();
    expect(api.getGitHubAppAccess).toHaveBeenCalledWith('acme/app');
    expect(screen.getByText('dialogs:githubAppAccess.repoSelected')).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 404/)).not.toBeInTheDocument();
    expect(screen.queryByText('github:repo-not-found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.addRepo' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/settings/installations');

    api.getGitHubBranches.mockResolvedValueOnce({ success: true, data: ['main'] });
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.checkAgainShort' }));
    await waitFor(() => expect(screen.queryByText('dialogs:githubAppAccess.repoTitle {"repo":"acme/app"}')).not.toBeInTheDocument());
    expect(api.getGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('offers to install the app when it is not installed on the owner', async () => {
    api.getGitHubBranches.mockResolvedValueOnce({ success: false, error: 'github:repo-not-found' });
    api.getGitHubAppAccess.mockImplementation(async (repo?: string) =>
      repo
        ? { success: true, data: { installed: false, repoReachable: false } }
        : { success: true, data: { installed: true, repositorySelection: 'all' } }
    );
    await toBranchStep();

    expect(await screen.findByText('dialogs:githubAppAccess.repoNotInstalled {"owner":"acme"}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.installApp' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/apps/vibe-teamlead-app/installations/new');
  });

  it('goes on to repository detection when the installation check fails', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: false, error: 'offline' });
    render(<GitHubSetupModal open onOpenChange={vi.fn()} project={project} onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /githubSetup.confirmAndContinue/ })).toBeInTheDocument();
    expect(api.detectGitHubRepo).toHaveBeenCalledWith('/tmp/app');
    expect(screen.queryByRole('button', { name: 'oauth-flow' })).not.toBeInTheDocument();
  });

  it('starts at sign-in when signed in but the app is not installed anywhere', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: false } });
    render(<GitHubSetupModal open onOpenChange={vi.fn()} project={project} onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'oauth-flow' })).toBeInTheDocument();
    expect(api.detectGitHubRepo).not.toHaveBeenCalled();
  });
});
