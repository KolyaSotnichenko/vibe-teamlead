import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveSession = vi.fn();
const saveSessionAsync = vi.fn(async () => undefined);
vi.mock('../../terminal-session-store', () => ({ getTerminalSessionStore: () => ({ saveSession, saveSessionAsync }) }));

import { persistAllSessions, persistAllSessionsAsync, persistSession, persistSessionAsync } from '../session-handler';
import type { TerminalProcess } from '../types';

const terminal = (over: Partial<TerminalProcess> = {}) =>
  ({ id: 't', pty: {}, isCLIMode: false, projectPath: '/p', cwd: '/p', outputBuffer: 'sk-ant-oat01-secret', title: 'T', ...over }) as unknown as TerminalProcess;

// "Get a token" prints a year-long subscription token: its output never goes to terminals.json
describe('a terminal that is never saved', () => {
  beforeEach(() => {
    saveSession.mockClear();
    saveSessionAsync.mockClear();
  });

  it('is skipped by every way of saving sessions', async () => {
    const secret = terminal({ id: 'token', ephemeral: true });
    persistSession(secret);
    persistSessionAsync(secret);
    persistAllSessions(new Map([['token', secret]]));
    await persistAllSessionsAsync(new Map([['token', secret]]));
    expect(saveSession).not.toHaveBeenCalled();
    expect(saveSessionAsync).not.toHaveBeenCalled();
  });

  it('a plain terminal is still saved', async () => {
    persistSession(terminal());
    await persistAllSessionsAsync(new Map([['a', terminal({ id: 'a' })], ['token', terminal({ id: 'token', ephemeral: true })]]));
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSessionAsync).toHaveBeenCalledTimes(1);
    expect(saveSessionAsync.mock.calls[0][0]).toMatchObject({ id: 'a' });
  });
});
