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
  getGitHubAppAccess: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  onGitHubAuthDeviceCode: vi.fn(() => () => {})
};
const vercel = {
  status: vi.fn(),
  connect: vi.fn(),
  cancelConnect: vi.fn(async () => ({ success: true })),
  setToken: vi.fn(),
  disconnect: vi.fn(),
  onConnectState: vi.fn(() => () => {})
};
(api as Record<string, unknown>).vercel = vercel;
Object.defineProperty(window, 'electronAPI', { value: api, writable: true });

describe('AccountsStep', () => {
  const onNext = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vercel.status.mockResolvedValue({ success: true, data: { connected: false } });
    api.checkGitHubAuth.mockResolvedValue({ success: true, data: { authenticated: false } });
    api.getGitHubToken.mockResolvedValue({ success: true, data: { token: 'tok' } });
    api.getGitHubAppAccess.mockResolvedValue({ success: true, data: { installed: true, repositorySelection: 'all' } });
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

  it('after signing in, asks to install the app before it counts as connected', async () => {
    api.checkGitHubAuth.mockResolvedValue({ success: true, data: { authenticated: true, username: 'octocat' } });
    api.getGitHubAppAccess.mockResolvedValueOnce({ success: true, data: { installed: false } });
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    expect(await screen.findByText('dialogs:githubAppAccess.title')).toBeInTheDocument();
    expect(screen.queryByText('onboarding:accounts.connectedAs:octocat')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.install' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/apps/vibe-teamlead-app/installations/new');
    fireEvent.click(screen.getByRole('button', { name: 'dialogs:githubAppAccess.checkAgain' }));
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

  it('renders the Vercel section with its panel', async () => {
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByText('onboarding:accounts.vercelTitle')).toBeInTheDocument();
    expect(screen.getByText('onboarding:accounts.vercelPurpose')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'vercel.connect' })).toBeInTheDocument();
  });

  it('offers Continue when only Vercel is connected', async () => {
    vercel.status.mockResolvedValue({ success: true, data: { connected: true, source: 'token', user: { username: 'ada' } } });
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding:accounts.continue' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'onboarding:accounts.skip' })).not.toBeInTheDocument();
  });

  it('offers Skip when neither is connected', async () => {
    render(<AccountsStep onNext={onNext} onBack={onBack} />);
    await screen.findByRole('button', { name: 'vercel.connect' });
    expect(screen.getByRole('button', { name: 'onboarding:accounts.skip' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'onboarding:accounts.continue' })).not.toBeInTheDocument();
  });
});
