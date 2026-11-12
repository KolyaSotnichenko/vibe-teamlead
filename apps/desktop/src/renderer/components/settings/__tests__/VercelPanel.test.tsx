/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { VercelPanel } from '../VercelPanel';
import type { VercelConnectState, VercelStatus } from '../../../../shared/types';

let pushState: ((s: VercelConnectState) => void) | undefined;
let finishConnect: ((r: { success: boolean; data?: VercelStatus; error?: string }) => void) | undefined;

const api = {
  status: vi.fn(),
  connect: vi.fn(),
  cancelConnect: vi.fn(async () => ({ success: true })),
  setToken: vi.fn(),
  disconnect: vi.fn(async () => ({ success: true, data: { connected: false } })),
  onConnectState: vi.fn((cb: (s: VercelConnectState) => void) => {
    pushState = cb;
    return () => {
      pushState = undefined;
    };
  }),
};

const connected: VercelStatus = {
  connected: true,
  source: 'browser',
  user: { username: 'ada', email: 'ada@example.com' },
  teams: [{ id: 't1', slug: 'acme', name: 'Acme' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.status.mockResolvedValue({ success: true, data: { connected: false } });
  api.connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishConnect = resolve;
      }),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = { vercel: api };
});

describe('VercelPanel', () => {
  it('not connected: Connect Vercel, then downloading, then waiting with the code and Cancel', async () => {
    render(<VercelPanel />);
    const connect = await screen.findByRole('button', { name: 'Connect Vercel' });
    fireEvent.click(connect);
    expect(api.connect).toHaveBeenCalled();

    act(() => pushState?.({ phase: 'downloading', percent: 42 }));
    expect(screen.getByText('Downloading Vercel CLI… 42%')).toBeInTheDocument();

    act(() => pushState?.({ phase: 'waiting', url: 'https://vercel.com/oauth/device?user_code=ABCD-EFGH', code: 'ABCD-EFGH' }));
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByText('Waiting for you in the browser…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelConnect).toHaveBeenCalled();
    await act(async () => finishConnect?.({ success: false, error: 'cancelled' }));
    expect(await screen.findByRole('button', { name: 'Connect Vercel' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['timeout', 'Vercel didn’t respond in time. Try again.'],
    ['download', 'The Vercel CLI couldn’t be downloaded. Check your connection and try again.'],
    ['cli', 'The Vercel sign-in didn’t finish. Try again.'],
    ['busy', 'A Vercel sign-in is already running.'],
    ['Some raw English from main', 'Something went wrong. Try again.'],
  ])('a failed sign-in of kind %s shows its own text', async (error, text) => {
    render(<VercelPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vercel' }));
    await act(async () => finishConnect?.({ success: false, error }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('a status error shows text by kind', async () => {
    api.status.mockResolvedValue({ success: true, data: { connected: false, error: 'unreachable' } });
    render(<VercelPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Vercel couldn’t be reached. Check your connection.');
  });

  it('a token refused for lack of encryption says so', async () => {
    api.setToken.mockResolvedValue({ success: false, error: 'encryption-unavailable' });
    render(<VercelPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Paste a token instead' }));
    fireEvent.change(screen.getByLabelText('Vercel token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This Mac can’t encrypt the token right now, so it wasn’t saved. Sign in in the browser instead.',
    );
  });

  it('connected: shows the user and teams, and Disconnect', async () => {
    api.status.mockResolvedValue({ success: true, data: connected });
    render(<VercelPanel />);
    expect(await screen.findByText('ada')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Connect Vercel' })).toBeInTheDocument();
  });

  it('a finished sign-in shows the account', async () => {
    render(<VercelPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vercel' }));
    await act(async () => finishConnect?.({ success: true, data: connected }));
    expect(await screen.findByText('ada')).toBeInTheDocument();
  });

  it('paste a token instead: a password field; a rejected token shows an error', async () => {
    api.setToken.mockResolvedValue({ success: true, data: { connected: false } });
    render(<VercelPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Paste a token instead' }));
    const field = screen.getByLabelText('Vercel token');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await waitFor(() => expect(api.setToken).toHaveBeenCalledWith('tok'));
    expect(await screen.findByText('Vercel did not accept this token.')).toBeInTheDocument();
  });

  it('reports connectedness to onStatusChange after the status read and after connecting', async () => {
    const onStatusChange = vi.fn();
    render(<VercelPanel onStatusChange={onStatusChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vercel' }));
    expect(onStatusChange).toHaveBeenCalledWith(false);
    await act(async () => finishConnect?.({ success: true, data: connected }));
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith(true));
  });

  it('reports true when already connected on load', async () => {
    api.status.mockResolvedValue({ success: true, data: connected });
    const onStatusChange = vi.fn();
    render(<VercelPanel onStatusChange={onStatusChange} />);
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(true));
  });

  it('unmounting during a running sign-in cancels it once', async () => {
    const { unmount } = render(<VercelPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vercel' }));
    unmount();
    expect(api.cancelConnect).toHaveBeenCalledTimes(1);
  });

  it('unmounting when idle does not cancel', async () => {
    const { unmount } = render(<VercelPanel />);
    await screen.findByRole('button', { name: 'Connect Vercel' });
    unmount();
    expect(api.cancelConnect).not.toHaveBeenCalled();
  });
});
