/**
 * The app's Vercel credential (Settings → Vercel).
 *
 * Two ways in:
 * - Browser sign-in: `vercel login` (device flow) runs with the app's private
 *   config dir `<userData>/vercel-cli/config` (0700). The CLI's own `auth.json`
 *   there (0600) is the OAuth token store; the CLI refreshes it whenever it
 *   runs, so a token about to expire is renewed by running `vercel whoami`.
 * - A pasted token, kept encrypted with safeStorage in
 *   `<userData>/vercel-credential.json`. When present it wins. Without safeStorage
 *   encryption it is refused, never stored as plain text.
 *
 * The CLI is downloaded only on browser sign-in, or (for a pasted token) on the
 * first Add database, both with progress and Cancel. A token refresh never
 * downloads it: without the CLI the stored token is used until it expires.
 * The CLI always runs in the private config dir.
 *
 * Failures are `VercelCredentialError`s with a `kind`; the UI shows its own text.
 *
 * Tokens are never logged and never sent to the renderer.
 * Main process only.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { VercelConnectState, VercelCredentialErrorKind, VercelStatus } from '../../shared/types/deploy';
import { ensureVercelCli, findInstalledVercelCli, runVercelCli, type EnsureVercelCliOptions } from './vercel-cli';

export type { VercelConnectState, VercelCredentialErrorKind, VercelStatus };

export class VercelCredentialError extends Error {
  readonly kind: VercelCredentialErrorKind;
  constructor(kind: VercelCredentialErrorKind, message: string) {
    super(message);
    this.name = 'VercelCredentialError';
    this.kind = kind;
  }
}

/** A CLI failure (download or run) as a credential error of the same kind. */
function fromCliError(err: unknown, fallback: VercelCredentialErrorKind): VercelCredentialError {
  if (err instanceof VercelCredentialError) return err;
  const kind = (err as { kind?: unknown })?.kind;
  if (kind === 'timeout' || kind === 'cancelled' || kind === 'download') return new VercelCredentialError(kind, `Vercel CLI: ${kind}`);
  return new VercelCredentialError(fallback, `Vercel CLI: ${fallback}`);
}

const API = 'https://api.vercel.com';
const DEVICE_URL = /https:\/\/vercel\.com\/oauth\/device\?user_code=([A-Z0-9-]+)/;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** The CLI must print the device URL within this, or the sign-in is given up. */
const DEVICE_URL_TIMEOUT_MS = 60_000;
const REFRESH_TIMEOUT_MS = 60_000;
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_S = 5 * 60;

export interface VercelCredentialDeps {
  userDataDir: string;
  ensureCli: (opts: EnsureVercelCliOptions) => Promise<string>;
  /** The installed CLI, or null; never downloads (`findInstalledVercelCli`). */
  findCli: (opts: { userDataDir: string }) => Promise<string | null>;
  /** safeStorage encryption is available: a pasted token is never stored without it. */
  canEncrypt: () => boolean;
  /** Tests only. */
  deviceUrlTimeoutMs?: number;
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
  /** The CLI binary (downloaded on first use, with progress and cancel, then kept for the session) and the private config dir. */
  cliPaths: (opts?: CliDownloadOptions) => Promise<{ binary: string; configDir: string }>;
  /** Is the CLI installed already? Never downloads. */
  isCliInstalled: () => Promise<boolean>;
}

export interface CliDownloadOptions {
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
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
  /** The CLI if it is installed (cached for the session); never downloads. */
  async function installedCli(): Promise<string | null> {
    if (binary) return binary;
    const found = await deps.findCli({ userDataDir: deps.userDataDir }).catch(() => null);
    if (found) binary = found;
    return found;
  }

  async function refreshCliToken(): Promise<string | null> {
    try {
      // no download here: without the CLI the token is used until it expires
      const bin = await installedCli();
      if (bin) {
        await ensureConfigDir();
        await runVercelCli(['whoami'], { binary: bin, configDir, cwd: configDir, timeoutMs: REFRESH_TIMEOUT_MS });
      }
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
      return { connected: false, error: 'unreachable' };
    }
    if (userRes.status === 401 || userRes.status === 403) return { connected: false };
    if (!userRes.ok) return { connected: false, error: 'unavailable' };
    const body = (await userRes.json().catch(() => ({}))) as { user?: { id?: string; uid?: string; username?: string; email?: string } };
    const id = body.user?.id ?? body.user?.uid;
    const user = {
      ...(typeof id === 'string' && id ? { id } : {}),
      username: body.user?.username ?? '',
      ...(body.user?.email ? { email: body.user.email } : {}),
    };

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
    const cancelled = () => new VercelCredentialError('cancelled', 'Vercel sign-in was cancelled');
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
      throw fromCliError(err, 'download');
    }
    await ensureConfigDir();

    let opened = false;
    // no device URL in time: the CLI is stuck (or changed its output); stop it
    const run = new AbortController();
    const onAbort = () => run.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let noUrl = false;
    const urlTimer = setTimeout(() => {
      if (opened) return;
      noUrl = true;
      run.abort();
    }, deps.deviceUrlTimeoutMs ?? DEVICE_URL_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof runVercelCli>>;
    try {
      result = await runVercelCli(['login'], {
        binary: bin,
        configDir,
        cwd: configDir,
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: run.signal,
        onOutput: (line) => {
          if (opened) return;
          const match = DEVICE_URL.exec(line);
          if (!match) return;
          opened = true;
          clearTimeout(urlTimer);
          onState({ phase: 'waiting', url: match[0], code: match[1] });
          void Promise.resolve(deps.openExternal(match[0])).catch(() => undefined);
        },
      });
    } catch (err) {
      if (signal.aborted) throw cancelled();
      if (noUrl) throw new VercelCredentialError('timeout', 'Vercel sign-in did not start in time');
      throw fromCliError(err, 'cli');
    } finally {
      clearTimeout(urlTimer);
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw cancelled();
    if (result.code !== 0) throw new VercelCredentialError('cli', 'Vercel sign-in did not finish');
    if (!(await readCliAuth())) throw new VercelCredentialError('cli', 'Vercel sign-in finished without a token');
    // the browser sign-in is what the user just chose: a pasted token would hide it
    await fs.rm(pastedFile, { force: true });
  }

  async function setVercelToken(token: string): Promise<VercelStatus> {
    const value = token.trim();
    if (!value) throw new VercelCredentialError('empty', 'The token is empty');
    if (!deps.canEncrypt()) throw new VercelCredentialError('encryption-unavailable', 'Encryption is unavailable');
    const status = await statusFor(value, 'token');
    if (!status.connected) return status;
    await fs.mkdir(path.dirname(pastedFile), { recursive: true });
    const stored = deps.encrypt(JSON.stringify({ token: value }));
    // safeStorage falls back to the plain value when it can't encrypt: never write that
    if (!stored.startsWith('enc:')) throw new VercelCredentialError('encryption-unavailable', 'Encryption is unavailable');
    await fs.writeFile(pastedFile, stored, { mode: 0o600 });
    await fs.chmod(pastedFile, 0o600);
    return status;
  }

  /** Local credentials only: `vercel logout` would act on the account. */
  async function disconnectVercel(): Promise<void> {
    await fs.rm(authFile, { force: true });
    await fs.rm(pastedFile, { force: true });
  }

  async function cliPaths(opts: CliDownloadOptions = {}): Promise<{ binary: string; configDir: string }> {
    let bin: string;
    try {
      bin = await cliBinary(opts);
    } catch (err) {
      if (opts.signal?.aborted) throw new VercelCredentialError('cancelled', 'Vercel CLI download was cancelled');
      throw fromCliError(err, 'download');
    }
    await ensureConfigDir();
    return { binary: bin, configDir };
  }

  async function isCliInstalled(): Promise<boolean> {
    return (await installedCli()) !== null;
  }

  return { getVercelToken, vercelStatus, connectVercel, setVercelToken, disconnectVercel, cliPaths, isCliInstalled };
}

let instance: VercelCredential | undefined;

/** The app's instance, wired to Electron (userData, shell, safeStorage). */
async function appCredential(): Promise<VercelCredential> {
  if (instance) return instance;
  const { app, safeStorage, shell } = await import('electron');
  const { decryptToken, encryptToken } = await import('../utils/token-encryption');
  instance = createVercelCredential({
    userDataDir: app.getPath('userData'),
    ensureCli: ensureVercelCli,
    findCli: (opts) => findInstalledVercelCli(opts),
    canEncrypt: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
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

export async function vercelCliPaths(opts?: CliDownloadOptions): Promise<{ binary: string; configDir: string }> {
  return (await appCredential()).cliPaths(opts);
}

export async function isVercelCliInstalled(): Promise<boolean> {
  return (await appCredential()).isCliInstalled();
}
