/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AccountsStep } from './AccountsStep';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts?.login ? `${key}:${opts.login}` : key),
    i18n: { language: 'en' }
  })
}));

const api = {
  checkGitHubAuth: vi.fn(),
  startGitHubAuth: vi.fn(),
  cancelGitHubAuth: vi.fn(),
  getGitHubUser: vi.fn(),
  getGitHubToken: vi.fn(),
  onGitHubAuthDeviceCode: vi.fn(() => () => {})
};
Object.defineProperty(window, 'electronAPI', { value: api, writable: true });

describe('AccountsStep', () => {
  const onNext = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    api.checkGitHubAuth.mockResolvedValue({ success: true, data: { authenticated: false } });
    api.getGitHubToken.mockResolvedValue({ success: true, data: { token: 'tok' } });
  });

  it('says what GitHub is for and where to connect later', async () => {
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByText('onboarding:accounts.purpose')).toBeInTheDocument();
    expect(screen.getByText('onboarding:accounts.later')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'dialogs:githubSignIn.start' })).toBeInTheDocument());
  });

  it('shows the login when already signed in', async () => {
    api.checkGitHubAuth.mockResolvedValue({ success: true, data: { authenticated: true, username: 'octocat' } });
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('onboarding:accounts.connectedAs:octocat')).toBeInTheDocument());
    expect(api.startGitHubAuth).not.toHaveBeenCalled();
  });

  it('starts sign-in through the same API the setup modal uses', async () => {
    api.startGitHubAuth.mockReturnValue(new Promise(() => {}));
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: 'dialogs:githubSignIn.start' }));
    expect(api.startGitHubAuth).toHaveBeenCalledTimes(1);
  });

  it('shows the login after a successful sign-in', async () => {
    api.startGitHubAuth.mockResolvedValue({ success: true });
    api.getGitHubUser.mockResolvedValue({ success: true, data: { username: 'octocat' } });
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: 'dialogs:githubSignIn.start' }));
    await waitFor(() => expect(screen.getByText('onboarding:accounts.connectedAs:octocat')).toBeInTheDocument());
  });

  it('Skip and Continue both move on, Back goes back', async () => {
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding:accounts.skip' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding:accounts.back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('offers Continue instead of Skip once connected', async () => {
    api.checkGitHubAuth.mockResolvedValue({ success: true, data: { authenticated: true, username: 'octocat' } });
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding:accounts.continue' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'onboarding:accounts.skip' })).not.toBeInTheDocument();
  });
});
