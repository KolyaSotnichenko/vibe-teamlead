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
    await act(async () => finishConnect?.({ success: false, error: 'Vercel sign-in was cancelled' }));
    expect(await screen.findByRole('button', { name: 'Connect Vercel' })).toBeInTheDocument();
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
});
