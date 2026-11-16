/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../../shared/i18n';
import type { TelegramStatus } from '../../../../shared/types/telegram';
import { TelegramSettings } from '../TelegramSettings';

const notifications = { agentQuestion: true, reviewWaiting: true, taskFailed: true, ciFailed: true, taskMerged: true, regression: true };

function mockApi(initial: TelegramStatus) {
  let push: ((s: TelegramStatus) => void) | undefined;
  const api = {
    getStatus: vi.fn(async () => initial),
    saveToken: vi.fn(async () => ({ success: true, data: { ...initial, connection: 'connected' as const, botUsername: 'my_bot' } })),
    testToken: vi.fn(async () => ({ success: true, data: { username: 'my_bot' } })),
    removeToken: vi.fn(async () => ({ connection: 'not_set' as const, notifications })),
    newPairingCode: vi.fn(async () => ({ ...initial, pairingCode: 'ABCD2345', pairingExpiresAt: Date.now() + 600_000 })),
    unpair: vi.fn(async () => ({ ...initial, owner: undefined })),
    setNotifications: vi.fn(async (n: typeof notifications) => ({ ...initial, notifications: n })),
    onStatus: vi.fn((cb: (s: TelegramStatus) => void) => {
      push = cb;
      return () => undefined;
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { telegram: api };
  return { api, push: (s: TelegramStatus) => act(() => push?.(s)) };
}

describe('Settings → Telegram', () => {
  beforeEach(() => vi.clearAllMocks());

  it('without a token: the steps, the token field, no pairing yet, the privacy note', async () => {
    const { api } = mockApi({ connection: 'not_set', notifications });
    render(<TelegramSettings />);
    expect(await screen.findByText(/No token\. The bot is off/)).toBeInTheDocument();
    expect(screen.getByText(/open @BotFather/)).toBeInTheDocument();
    expect(screen.getByText('Save a token first to pair.')).toBeInTheDocument();
    expect(screen.getByText(/not end-to-end encrypted/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '123:abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveToken).toHaveBeenCalledWith('123:abc'));
    expect(await screen.findByText('Connected as @my_bot')).toBeInTheDocument();
    // The field is cleared: the token is not shown again
    expect(screen.getByLabelText('Bot token')).toHaveValue('');
  });

  it('shows why a token was refused', async () => {
    const { api } = mockApi({ connection: 'not_set', notifications });
    api.saveToken.mockResolvedValueOnce({ success: false, error: 'bad_token' } as never);
    render(<TelegramSettings />);
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/does not accept this token/)).toBeInTheDocument();
  });

  it('with a token: a pairing code with the /start command, then the owner with Unpair', async () => {
    const { api, push } = mockApi({ connection: 'connected', botUsername: 'my_bot', notifications });
    render(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New code' }));
    expect(await screen.findByText('/start ABCD2345')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the bot in Telegram' })).toHaveAttribute('href', 'https://t.me/my_bot?start=ABCD2345');
    push({ connection: 'connected', botUsername: 'my_bot', owner: { userId: 1, chatId: 1, name: '@nick' }, notifications });
    expect(await screen.findByText('Paired with @nick')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    await waitFor(() => expect(api.unpair).toHaveBeenCalled());
  });

  it('an error status says the reason', async () => {
    mockApi({ connection: 'error', error: 'conflict', notifications });
    render(<TelegramSettings />);
    expect(await screen.findByText(/Another program is reading this bot's messages/)).toBeInTheDocument();
  });

  it('notification switches save at once', async () => {
    const { api } = mockApi({ connection: 'connected', notifications });
    render(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'A task was merged' }));
    await waitFor(() => expect(api.setNotifications).toHaveBeenCalledWith({ ...notifications, taskMerged: false }));
  });
});
