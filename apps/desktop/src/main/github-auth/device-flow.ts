/**
 * GitHub App device flow (user access tokens).
 *
 * Vibe Teamlead signs users in with its own GitHub App instead of the gh CLI:
 * no client secret ships in the app, the user picks which repositories the
 * app may touch, and tokens expire (8h) with a refresh token (6 months).
 *
 * Docs: https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 */

/** Public identifiers of the Vibe Teamlead GitHub App (not secrets). */
export const GITHUB_APP = {
  clientId: 'Iv23liatVHpmqmpbu4xo',
  slug: 'vibe-teamlead-app',
} as const;

export const GITHUB_INSTALL_URL = `https://github.com/apps/${GITHUB_APP.slug}/installations/new`;

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubTokens {
  accessToken: string;
  /** Epoch ms; undefined when the token does not expire */
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export class DeviceFlowError extends Error {
  constructor(
    readonly code: 'expired_token' | 'access_denied' | 'aborted' | 'bad_response' | string,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

async function postForm(fetchImpl: FetchLike, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    throw new DeviceFlowError('bad_response', `GitHub returned HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export function toTokens(data: Record<string, unknown>, now = Date.now()): GitHubTokens {
  const accessToken = data.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new DeviceFlowError('bad_response', 'GitHub did not return an access token');
  }
  const expiresIn = Number(data.expires_in);
  const refreshExpiresIn = Number(data.refresh_token_expires_in);
  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    refreshExpiresAt: Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : undefined,
  };
}

export async function requestDeviceCode(fetchImpl: FetchLike = fetch): Promise<DeviceCode> {
  const data = await postForm(fetchImpl, DEVICE_CODE_URL, { client_id: GITHUB_APP.clientId });
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    throw new DeviceFlowError('bad_response', String(data.error_description ?? 'Device code request failed'));
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: String(data.verification_uri ?? 'https://github.com/login/device'),
    expiresIn: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DeviceFlowError('aborted', 'Sign-in cancelled'));
      },
      { once: true },
    );
  });

/**
 * Poll until the user approves the code in the browser.
 * Honors `slow_down` (+5s) and stops on expiry, denial or abort.
 */
export async function pollForToken(
  code: DeviceCode,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; sleep?: typeof defaultSleep; now?: () => number } = {},
): Promise<GitHubTokens> {
  const { fetchImpl = fetch, signal, sleep = defaultSleep, now = Date.now } = options;
  const deadline = now() + code.expiresIn * 1000;
  let intervalMs = code.interval * 1000;

  while (now() < deadline) {
    if (signal?.aborted) throw new DeviceFlowError('aborted', 'Sign-in cancelled');
    await sleep(intervalMs, signal);
    const data = await postForm(fetchImpl, TOKEN_URL, {
      client_id: GITHUB_APP.clientId,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof data.access_token === 'string') return toTokens(data, now());
    switch (data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs = (Number(data.interval) || intervalMs / 1000 + 5) * 1000;
        continue;
      case 'expired_token':
        throw new DeviceFlowError('expired_token', 'The sign-in code expired. Start again.');
      case 'access_denied':
        throw new DeviceFlowError('access_denied', 'Sign-in was cancelled on GitHub.');
      default:
        throw new DeviceFlowError(String(data.error ?? 'bad_response'), String(data.error_description ?? 'Sign-in failed'));
    }
  }
  throw new DeviceFlowError('expired_token', 'The sign-in code expired. Start again.');
}

/** Exchange a refresh token for a new access token. */
export async function refreshTokens(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<GitHubTokens> {
  const data = await postForm(fetchImpl, TOKEN_URL, {
    client_id: GITHUB_APP.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (data.error) {
    throw new DeviceFlowError(String(data.error), String(data.error_description ?? 'Token refresh failed'));
  }
  return toTokens(data);
}
