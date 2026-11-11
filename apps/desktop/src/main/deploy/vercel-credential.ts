/**
 * The app's Vercel credential (Settings → Vercel).
 *
 * Two ways in:
 * - Browser sign-in: `vercel login` (device flow) runs with the app's private
 *   config dir `<userData>/vercel-cli/config` (0700). The CLI's own `auth.json`
 *   there (0600) is the OAuth token store; the CLI refreshes it whenever it
 *   runs, so a token about to expire is renewed by running `vercel whoami`.
 * - A pasted token, kept encrypted with safeStorage in
 *   `<userData>/vercel-credential.json`. When present it wins.
 *
 * Tokens are never logged and never sent to the renderer.
 * Main process only.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { VercelConnectState, VercelStatus } from '../../shared/types/deploy';
import { ensureVercelCli, runVercelCli, type EnsureVercelCliOptions } from './vercel-cli';

export type { VercelConnectState, VercelStatus };

const API = 'https://api.vercel.com';
const DEVICE_URL = /https:\/\/vercel\.com\/oauth\/device\?user_code=([A-Z0-9-]+)/;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_TIMEOUT_MS = 60_000;
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_S = 5 * 60;

export interface VercelCredentialDeps {
  userDataDir: string;
  ensureCli: (opts: EnsureVercelCliOptions) => Promise<string>;
  openExternal: (url: string) => void | Promise<void>;
  fetchImpl: typeof fetch;
  encrypt: (plain: string) => string;
  decrypt: (stored: string) => string;
  /** Milliseconds, like Date.now. */
  now: () => number;
}

interface CliAuth {
  token: string;
  expiresAt?: number;
}

export interface VercelCredential {
  getVercelToken: () => Promise<string | null>;
  vercelStatus: () => Promise<VercelStatus>;
  connectVercel: (onState: (state: VercelConnectState) => void, signal: AbortSignal) => Promise<void>;
  setVercelToken: (token: string) => Promise<VercelStatus>;
  disconnectVercel: () => Promise<void>;
}

export function createVercelCredential(deps: VercelCredentialDeps): VercelCredential {
  const configDir = path.join(deps.userDataDir, 'vercel-cli', 'config');
  const authFile = path.join(configDir, 'auth.json');
  const pastedFile = path.join(deps.userDataDir, 'vercel-credential.json');
  let binary: string | undefined;
  let refreshing: Promise<string | null> | undefined;

  async function ensureConfigDir(): Promise<void> {
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.chmod(configDir, 0o700);
  }

  /** ensureVercelCli re-hashes the 176 MB binary, so the path is kept for the app session. */
  async function cliBinary(opts: Omit<EnsureVercelCliOptions, 'userDataDir'> = {}): Promise<string> {
    if (binary) return binary;
    binary = await deps.ensureCli({ ...opts, userDataDir: deps.userDataDir });
    return binary;
  }

  async function readPasted(): Promise<string | null> {
    try {
      const plain = deps.decrypt(await fs.readFile(pastedFile, 'utf8'));
      const token = plain ? (JSON.parse(plain) as { token?: unknown }).token : undefined;
      return typeof token === 'string' && token ? token : null;
    } catch {
      return null;
    }
  }

  async function readCliAuth(): Promise<CliAuth | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(authFile, 'utf8')) as { token?: unknown; expiresAt?: unknown };
      if (typeof parsed.token !== 'string' || !parsed.token) return null;
      return { token: parsed.token, expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined };
    } catch {
      return null;
    }
  }

  const nowS = () => deps.now() / 1000;

  /** Any CLI run with our config dir refreshes an expired OAuth token and rewrites auth.json. */
  async function refreshCliToken(): Promise<string | null> {
    try {
      const bin = await cliBinary();
      await runVercelCli(['whoami'], { binary: bin, configDir, timeoutMs: REFRESH_TIMEOUT_MS });
    } catch {
      // the re-read below decides
    }
    const auth = await readCliAuth();
    if (!auth) return null;
    return auth.expiresAt === undefined || auth.expiresAt > nowS() ? auth.token : null;
  }

  async function getVercelToken(): Promise<string | null> {
    const pasted = await readPasted();
    if (pasted) return pasted;
    const auth = await readCliAuth();
    if (!auth) return null;
    if (auth.expiresAt === undefined || auth.expiresAt - nowS() >= REFRESH_MARGIN_S) return auth.token;
    refreshing ??= refreshCliToken().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function statusFor(token: string, source: VercelStatus['source']): Promise<VercelStatus> {
    const get = (endpoint: string) =>
      deps.fetchImpl(`${API}${endpoint}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    let userRes: Response;
    try {
      userRes = await get('/v2/user');
    } catch {
      return { connected: false, error: 'Vercel could not be reached' };
    }
    if (userRes.status === 401 || userRes.status === 403) return { connected: false };
    if (!userRes.ok) return { connected: false, error: `Vercel answered HTTP ${userRes.status}` };
    const body = (await userRes.json().catch(() => ({}))) as { user?: { username?: string; email?: string } };
    const user = { username: body.user?.username ?? '', ...(body.user?.email ? { email: body.user.email } : {}) };

    let teams: NonNullable<VercelStatus['teams']> = [];
    try {
      const teamsRes = await get('/v2/teams');
      if (teamsRes.ok) {
        const t = (await teamsRes.json()) as { teams?: Array<{ id?: string; slug?: string; name?: string }> };
        teams = (t.teams ?? [])
          .filter((x) => typeof x.id === 'string')
          .map((x) => ({ id: x.id as string, slug: x.slug ?? '', name: x.name ?? x.slug ?? '' }));
      }
    } catch {
      // teams are optional: a personal account still deploys
    }
    return { connected: true, source, user, teams };
  }

  async function vercelStatus(): Promise<VercelStatus> {
    const pasted = await readPasted();
    const token = pasted ?? (await getVercelToken());
    if (!token) return { connected: false };
    return statusFor(token, pasted ? 'token' : 'browser');
  }

  async function connectVercel(onState: (state: VercelConnectState) => void, signal: AbortSignal): Promise<void> {
    const cancelled = () => new Error('Vercel sign-in was cancelled');
    if (signal.aborted) throw cancelled();
    let lastPercent = -1;
    let bin: string;
    try {
      bin = await cliBinary({
        signal,
        onProgress: (received, total) => {
          const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
          if (percent === lastPercent) return;
          lastPercent = percent;
          onState({ phase: 'downloading', percent });
        },
      });
    } catch (err) {
      if (signal.aborted) throw cancelled();
      throw err;
    }
    await ensureConfigDir();

    let opened = false;
    let result: Awaited<ReturnType<typeof runVercelCli>>;
    try {
      result = await runVercelCli(['login'], {
        binary: bin,
        configDir,
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal,
        onOutput: (line) => {
          if (opened) return;
          const match = DEVICE_URL.exec(line);
          if (!match) return;
          opened = true;
          onState({ phase: 'waiting', url: match[0], code: match[1] });
          void Promise.resolve(deps.openExternal(match[0])).catch(() => undefined);
        },
      });
    } catch (err) {
      if (signal.aborted) throw cancelled();
      throw err;
    }
    if (signal.aborted) throw cancelled();
    if (result.code !== 0) throw new Error('Vercel sign-in did not finish');
    if (!(await readCliAuth())) throw new Error('Vercel sign-in finished without a token');
    // the browser sign-in is what the user just chose: a pasted token would hide it
    await fs.rm(pastedFile, { force: true });
  }

  async function setVercelToken(token: string): Promise<VercelStatus> {
    const value = token.trim();
    if (!value) throw new Error('The token is empty');
    const status = await statusFor(value, 'token');
    if (!status.connected) return status;
    await fs.mkdir(path.dirname(pastedFile), { recursive: true });
    await fs.writeFile(pastedFile, deps.encrypt(JSON.stringify({ token: value })), { mode: 0o600 });
    await fs.chmod(pastedFile, 0o600);
    return status;
  }

  /** Local credentials only: `vercel logout` would act on the account. */
  async function disconnectVercel(): Promise<void> {
    await fs.rm(authFile, { force: true });
    await fs.rm(pastedFile, { force: true });
  }

  return { getVercelToken, vercelStatus, connectVercel, setVercelToken, disconnectVercel };
}

let instance: VercelCredential | undefined;

/** The app's instance, wired to Electron (userData, shell, safeStorage). */
async function appCredential(): Promise<VercelCredential> {
  if (instance) return instance;
  const { app, shell } = await import('electron');
  const { decryptToken, encryptToken } = await import('../utils/token-encryption');
  instance = createVercelCredential({
    userDataDir: app.getPath('userData'),
    ensureCli: ensureVercelCli,
    openExternal: (url) => shell.openExternal(url),
    fetchImpl: (...args) => fetch(...args),
    encrypt: encryptToken,
    decrypt: decryptToken,
    now: () => Date.now(),
  });
  return instance;
}

export async function getVercelToken(): Promise<string | null> {
  return (await appCredential()).getVercelToken();
}

export async function vercelStatus(): Promise<VercelStatus> {
  return (await appCredential()).vercelStatus();
}

export async function connectVercel(
  onState: (state: VercelConnectState) => void,
  signal: AbortSignal,
): Promise<void> {
  return (await appCredential()).connectVercel(onState, signal);
}

export async function setVercelToken(token: string): Promise<VercelStatus> {
  return (await appCredential()).setVercelToken(token);
}

export async function disconnectVercel(): Promise<void> {
  return (await appCredential()).disconnectVercel();
}
