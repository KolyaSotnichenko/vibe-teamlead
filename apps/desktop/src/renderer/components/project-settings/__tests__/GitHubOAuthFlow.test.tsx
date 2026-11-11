/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubOAuthFlow } from '../GitHubOAuthFlow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const api = {
  checkGitHubAuth: vi.fn(),
  getGitHubToken: vi.fn(),
  getGitHubAppAccess: vi.fn(),
  startGitHubAuth: vi.fn(),
  cancelGitHubAuth: vi.fn(),
  getGitHubUser: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  onGitHubAuthDeviceCode: vi.fn(() => () => {}),
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  api.checkGitHubAuth.mockResolvedValue({ success: true, data: { authenticated: true, username: 'octocat' } });
  api.getGitHubToken.mockResolvedValue({ success: true, data: { token: 'ghu_x' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitHubOAuthFlow', () => {
  it('already signed in and the app installed: succeeds without asking anything', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: true, repositorySelection: 'all' } });
    const onSuccess = vi.fn();
    render(<GitHubOAuthFlow onSuccess={onSuccess} />);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('ghu_x', 'octocat'));
    expect(screen.queryByText('dialogs:githubAppAccess.title')).not.toBeInTheDocument();
  });

  it('when the installation check fails, "continue anyway" finishes the sign-in', async () => {
    api.getGitHubAppAccess.mockResolvedValue({ success: false, error: 'offline' });
    const onSuccess = vi.fn();
    render(<GitHubOAuthFlow onSuccess={onSuccess} />);
    fireEvent.click(await screen.findByRole('button', { name: 'dialogs:githubAppAccess.continueAnyway' }));
    expect(onSuccess).toHaveBeenCalledWith('ghu_x', 'octocat');
  });
});
