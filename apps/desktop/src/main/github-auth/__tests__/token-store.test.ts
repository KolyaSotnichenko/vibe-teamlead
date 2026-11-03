import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(join(tmpdir(), 'vtl-gh-'));
vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('../../claude-profile/token-encryption', () => ({
  encryptToken: (s: string) => s,
  decryptToken: (s: string) => s,
}));
const refreshTokens = vi.fn();
vi.mock('../device-flow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-flow')>();
  return { ...actual, refreshTokens: (...args: unknown[]) => refreshTokens(...args) };
});

import { DeviceFlowError } from '../device-flow';
import {
  clearGitHubAuth,
  getStoredAccessTokenSync,
  getValidAccessToken,
  loadGitHubAuth,
  resetGitHubAuthCacheForTests,
  saveGitHubAuth,
} from '../token-store';

const expired = () => ({ accessToken: 'old', expiresAt: Date.now() - 1000, refreshToken: 'r1', login: 'mykola' });

describe('GitHub token store', () => {
  beforeEach(() => {
    refreshTokens.mockReset();
    clearGitHubAuth();
    resetGitHubAuthCacheForTests();
  });
  afterEach(() => clearGitHubAuth());

  it('persists, caches and clears the auth', () => {
    saveGitHubAuth({ accessToken: 'a', login: 'mykola' });
    resetGitHubAuthCacheForTests();
    expect(loadGitHubAuth()?.login).toBe('mykola');
    expect(getStoredAccessTokenSync()).toBe('a');
    clearGitHubAuth();
    expect(getStoredAccessTokenSync()).toBeNull();
  });

  it('refreshes once for concurrent callers and keeps the login', async () => {
    saveGitHubAuth(expired());
    refreshTokens.mockResolvedValue({ accessToken: 'new', expiresAt: Date.now() + 8 * 3600_000, refreshToken: 'r2' });
    const [a, b] = await Promise.all([getValidAccessToken(), getValidAccessToken()]);
    expect([a, b]).toEqual(['new', 'new']);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(loadGitHubAuth()).toMatchObject({ accessToken: 'new', login: 'mykola' });
  });

  it('keeps the user signed in when the refresh fails for a network reason', async () => {
    saveGitHubAuth(expired());
    refreshTokens.mockRejectedValue(new TypeError('fetch failed'));
    expect(await getValidAccessToken()).toBeNull();
    expect(loadGitHubAuth()?.refreshToken).toBe('r1');
  });

  it('signs out when GitHub rejects the refresh token', async () => {
    saveGitHubAuth(expired());
    refreshTokens.mockRejectedValue(new DeviceFlowError('bad_refresh_token', 'revoked'));
    expect(await getValidAccessToken()).toBeNull();
    expect(loadGitHubAuth()).toBeNull();
  });

  it('does not let an old refresh overwrite a newer sign-in', async () => {
    saveGitHubAuth(expired());
    let finish: (v: unknown) => void = () => {};
    refreshTokens.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = getValidAccessToken();
    saveGitHubAuth({ accessToken: 'other-account', login: 'someone' });
    finish({ accessToken: 'refreshed-old', expiresAt: Date.now() + 3600_000 });
    expect(await pending).toBe('other-account');
    expect(loadGitHubAuth()?.login).toBe('someone');
  });
});
