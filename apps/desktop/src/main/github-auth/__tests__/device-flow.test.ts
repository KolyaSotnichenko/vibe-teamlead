import { describe, expect, it, vi } from 'vitest';

import {
  DeviceFlowError,
  type FetchLike,
  GITHUB_APP,
  pollForToken,
  refreshTokens,
  requestDeviceCode,
  toTokens,
} from '../device-flow';

function fakeFetch(responses: Record<string, unknown>[]): FetchLike & { calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    const next = responses.shift() ?? {};
    return { ok: true, status: 200, json: async () => next };
  });
  return Object.assign(impl, { calls });
}

const noSleep = vi.fn(async () => undefined);
const code = { deviceCode: 'dev-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };

describe('GitHub device flow', () => {
  it('requests a device code with the app client id only (no secret)', async () => {
    const fetchImpl = fakeFetch([
      { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    ]);
    const result = await requestDeviceCode(fetchImpl);
    expect(result).toEqual(code);
    expect(fetchImpl.calls[0].body).toBe(`client_id=${GITHUB_APP.clientId}`);
  });

  it('polls through pending and slow_down until a token arrives', async () => {
    const fetchImpl = fakeFetch([
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      { access_token: 'ghu_x', expires_in: 28800, refresh_token: 'ghr_y', refresh_token_expires_in: 15897600 },
    ]);
    const tokens = await pollForToken(code, { fetchImpl, sleep: noSleep, now: () => 1_000 });
    expect(tokens).toEqual({
      accessToken: 'ghu_x',
      expiresAt: 1_000 + 28800 * 1000,
      refreshToken: 'ghr_y',
      refreshExpiresAt: 1_000 + 15897600 * 1000,
    });
    expect(noSleep).toHaveBeenLastCalledWith(10_000, undefined);
    expect(fetchImpl.calls[0].body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
  });

  it('stops on denial and expiry', async () => {
    await expect(pollForToken(code, { fetchImpl: fakeFetch([{ error: 'access_denied' }]), sleep: noSleep })).rejects.toMatchObject({
      code: 'access_denied',
    });
    await expect(pollForToken(code, { fetchImpl: fakeFetch([{ error: 'expired_token' }]), sleep: noSleep })).rejects.toBeInstanceOf(
      DeviceFlowError,
    );
  });

  it('refreshes tokens with the refresh_token grant', async () => {
    const fetchImpl = fakeFetch([{ access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new' }]);
    const tokens = await refreshTokens('ghr_old', fetchImpl);
    expect(tokens.accessToken).toBe('ghu_new');
    expect(fetchImpl.calls[0].body).toContain('grant_type=refresh_token');
    expect(fetchImpl.calls[0].body).toContain('refresh_token=ghr_old');
  });

  it('treats tokens without expires_in as non-expiring', () => {
    expect(toTokens({ access_token: 'ghu_z' })).toEqual({ accessToken: 'ghu_z' });
  });
});
