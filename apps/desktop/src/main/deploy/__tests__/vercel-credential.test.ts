import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnsureVercelCliOptions } from '../vercel-cli';
import { createVercelCredential, type VercelConnectState } from '../vercel-credential';

// Fakes only: the "CLI" is a shell script written per test. The real Vercel CLI is never run.

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'vc-cred-test-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const NOW = 1_800_000_000; // seconds
const userData = () => path.join(work, 'userData');
const configDir = () => path.join(userData(), 'vercel-cli', 'config');
const authFile = () => path.join(configDir(), 'auth.json');
const pastedFile = () => path.join(userData(), 'vercel-credential.json');

/** A fake CLI: `login` prints the device URL, then runs `loginBody`; `whoami` runs `whoamiBody`. */
function fakeCli(opts: { loginBody?: string; whoamiBody?: string; noDeviceUrl?: boolean } = {}): string {
  const bin = path.join(work, 'fake-vercel');
  const script = `#!/bin/sh
cmd="$1"
dir=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--global-config" ]; then dir="$2"; fi
  shift
done
echo "$cmd" >> "${work}/calls.log"
pwd -P >> "${work}/cwd.log"
case "$cmd" in
  login)
    echo "Vercel CLI 65.14.0"
    ${opts.noDeviceUrl ? 'echo "  Waiting…"' : 'echo "  Visit https://vercel.com/oauth/device?user_code=ABCD-EFGH"'}
    ${opts.loginBody ?? 'exit 1'}
    ;;
  whoami)
    ${opts.whoamiBody ?? 'echo someone'}
    ;;
esac
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

const writeAuthBody = (token: string, expiresAt: number) =>
  `mkdir -p "$dir"; printf '%s' '{"token":"${token}","refreshToken":"vcr_r","expiresAt":${expiresAt},"userId":"u1"}' > "$dir/auth.json"; chmod 600 "$dir/auth.json"; echo "> Success!"; exit 0`;

function writeAuth(token: string, expiresAt: number) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(authFile(), JSON.stringify({ token, refreshToken: 'vcr_r', expiresAt, userId: 'u1' }), { mode: 0o600 });
}

function cliCalls(): string[] {
  const f = path.join(work, 'calls.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
}

interface ApiCall {
  url: string;
  auth: string | null;
}

/** A fake Vercel API: `valid` tokens get a user and two teams, others 401. */
function fakeApi(valid: string[], calls: ApiCall[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url: String(url), auth });
    if (!auth || !valid.includes(auth.replace(/^Bearer /, ''))) {
      return new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: 403 });
    }
    if (String(url).endsWith('/v2/user')) {
      return Response.json({ user: { id: 'u1', username: 'ada', email: 'ada@example.com' } });
    }
    if (String(url).endsWith('/v2/teams')) {
      return Response.json({ teams: [{ id: 't1', slug: 'acme', name: 'Acme' }] });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function make(
  opts: {
    bin?: string;
    valid?: string[];
    apiCalls?: ApiCall[];
    openExternal?: (url: string) => void;
    ensure?: (o: EnsureVercelCliOptions) => Promise<string>;
    installed?: boolean;
    canEncrypt?: boolean;
    fetchImpl?: typeof fetch;
    deviceUrlTimeoutMs?: number;
  } = {},
) {
  const bin = opts.bin ?? fakeCli();
  const ensureCli =
    opts.ensure ??
    vi.fn(async (o: EnsureVercelCliOptions) => {
      o.onProgress?.(50, 100);
      o.onProgress?.(100, 100);
      return bin;
    });
  const openExternal = opts.openExternal ?? vi.fn();
  const findCli = vi.fn(async () => (opts.installed === false ? null : bin));
  const cred = createVercelCredential({
    userDataDir: userData(),
    ensureCli,
    findCli,
    canEncrypt: () => opts.canEncrypt ?? true,
    ...(opts.deviceUrlTimeoutMs ? { deviceUrlTimeoutMs: opts.deviceUrlTimeoutMs } : {}),
    openExternal,
    fetchImpl: opts.fetchImpl ?? fakeApi(opts.valid ?? [], opts.apiCalls),
    // reversible stand-in for safeStorage, so a plain-text token on disk is detectable
    encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
    decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString() : ''),
    now: () => NOW * 1000,
  });
  return { cred, ensureCli, openExternal, findCli };
}

describe('connectVercel', () => {
  it('downloads the CLI, shows the device code, opens the URL once, and is connected after login', async () => {
    const bin = fakeCli({ loginBody: writeAuthBody('vca_browser', NOW + 28800) });
    const { cred, openExternal, ensureCli } = make({ bin, valid: ['vca_browser'] });
    const states: VercelConnectState[] = [];
    await cred.connectVercel((s) => states.push(s), new AbortController().signal);

    expect(states).toContainEqual({ phase: 'downloading', percent: 50 });
    expect(states).toContainEqual({
      phase: 'waiting',
      url: 'https://vercel.com/oauth/device?user_code=ABCD-EFGH',
      code: 'ABCD-EFGH',
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://vercel.com/oauth/device?user_code=ABCD-EFGH');
    expect(statSync(configDir()).mode & 0o777).toBe(0o700);
    expect(await cred.getVercelToken()).toBe('vca_browser');
    const status = await cred.vercelStatus();
    expect(status).toEqual({
      connected: true,
      source: 'browser',
      user: { id: 'u1', username: 'ada', email: 'ada@example.com' },
      teams: [{ id: 't1', slug: 'acme', name: 'Acme' }],
    });

    // the binary path is cached for the app session
    await cred.connectVercel(() => undefined, new AbortController().signal);
    expect(ensureCli).toHaveBeenCalledTimes(1);
  });

  it('fails when the CLI exits non-zero, and stores nothing', async () => {
    const { cred } = make({ bin: fakeCli({ loginBody: 'echo "Timed out waiting for authentication." >&2; exit 1' }) });
    await expect(cred.connectVercel(() => undefined, new AbortController().signal)).rejects.toThrow();
    expect(existsSync(authFile())).toBe(false);
    expect(await cred.getVercelToken()).toBeNull();
  });

  it('fails when the CLI exits 0 without writing auth.json', async () => {
    const { cred } = make({ bin: fakeCli({ loginBody: 'exit 0' }) });
    await expect(cred.connectVercel(() => undefined, new AbortController().signal)).rejects.toThrow();
    expect(await cred.getVercelToken()).toBeNull();
  });

  it('cancel kills the login and stores nothing', async () => {
    // would write a token after 3 s; cancel comes first
    const bin = fakeCli({ loginBody: `sleep 3; ${writeAuthBody('vca_late', NOW + 28800)}` });
    const { cred } = make({ bin });
    const controller = new AbortController();
    const done = cred.connectVercel((s) => {
      if (s.phase === 'waiting') controller.abort();
    }, controller.signal);
    await expect(done).rejects.toMatchObject({ kind: 'cancelled' });
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(authFile())).toBe(false);
    expect(await cred.getVercelToken()).toBeNull();
  }, 10_000);

  it('gives up with kind timeout when the CLI shows no device URL in time, and kills it', async () => {
    const bin = fakeCli({ noDeviceUrl: true, loginBody: `sleep 5; ${writeAuthBody('vca_late', NOW + 28800)}` });
    const { cred, openExternal } = make({ bin, deviceUrlTimeoutMs: 200 });
    const started = Date.now();
    await expect(cred.connectVercel(() => undefined, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(openExternal).not.toHaveBeenCalled();
    expect(existsSync(authFile())).toBe(false);
  }, 10_000);

  it('a failed CLI download rejects with its kind', async () => {
    const ensure = vi.fn(async () => {
      throw Object.assign(new Error('Vercel CLI download timed out'), { kind: 'timeout' });
    });
    const { cred } = make({ ensure });
    await expect(cred.connectVercel(() => undefined, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('a CLI exiting non-zero rejects with kind cli', async () => {
    const { cred } = make({ bin: fakeCli({ loginBody: 'exit 1' }) });
    await expect(cred.connectVercel(() => undefined, new AbortController().signal)).rejects.toMatchObject({ kind: 'cli' });
  });

  it('runs the CLI in the private config dir', async () => {
    const bin = fakeCli({ loginBody: writeAuthBody('vca_browser', NOW + 28800) });
    const { cred } = make({ bin, valid: ['vca_browser'] });
    await cred.connectVercel(() => undefined, new AbortController().signal);
    const cwds = readFileSync(path.join(work, 'cwd.log'), 'utf8').trim().split('\n');
    expect(cwds).toEqual([realpathSync(configDir())]);
  });

  it('a browser sign-in replaces a pasted token', async () => {
    const bin = fakeCli({ loginBody: writeAuthBody('vca_browser', NOW + 28800) });
    const { cred } = make({ bin, valid: ['pasted_tok', 'vca_browser'] });
    await cred.setVercelToken('pasted_tok');
    await cred.connectVercel(() => undefined, new AbortController().signal);
    expect(await cred.getVercelToken()).toBe('vca_browser');
    expect(existsSync(pastedFile())).toBe(false);
  });
});

describe('getVercelToken', () => {
  it('returns null when not signed in', async () => {
    const { cred } = make();
    expect(await cred.getVercelToken()).toBeNull();
  });

  it('returns a fresh token without running the CLI', async () => {
    writeAuth('vca_fresh', NOW + 3600);
    const { cred } = make();
    expect(await cred.getVercelToken()).toBe('vca_fresh');
    expect(cliCalls()).toEqual([]);
  });

  it('runs whoami (the CLI refreshes) when the token expires within 5 minutes, then re-reads it', async () => {
    writeAuth('vca_old', NOW + 120);
    const bin = fakeCli({ whoamiBody: writeAuthBody('vca_new', NOW + 28800) });
    const { cred } = make({ bin });
    expect(await cred.getVercelToken()).toBe('vca_new');
    expect(cliCalls()).toEqual(['whoami']);
  });

  it('returns null when the token is still expired after the refresh attempt', async () => {
    writeAuth('vca_dead', NOW - 10);
    const bin = fakeCli({ whoamiBody: 'echo "Error: invalid_grant" >&2; exit 1' });
    const { cred } = make({ bin });
    expect(await cred.getVercelToken()).toBeNull();
    expect(cliCalls()).toEqual(['whoami']);
  });

  it('never downloads the CLI: when it is not installed, a near-expiry token is returned as is', async () => {
    writeAuth('vca_old', NOW + 120);
    const { cred, ensureCli } = make({ installed: false });
    expect(await cred.getVercelToken()).toBe('vca_old');
    expect(ensureCli).not.toHaveBeenCalled();
    expect(cliCalls()).toEqual([]);
  });

  it('never downloads the CLI: when it is not installed, an expired token gives null (reconnect)', async () => {
    writeAuth('vca_dead', NOW - 10);
    const { cred, ensureCli } = make({ installed: false, valid: ['vca_dead'] });
    expect(await cred.getVercelToken()).toBeNull();
    expect((await cred.vercelStatus()).connected).toBe(false);
    expect(ensureCli).not.toHaveBeenCalled();
  });

  it('refreshes in the private config dir', async () => {
    writeAuth('vca_old', NOW + 120);
    const bin = fakeCli({ whoamiBody: writeAuthBody('vca_new', NOW + 28800) });
    const { cred } = make({ bin });
    await cred.getVercelToken();
    expect(readFileSync(path.join(work, 'cwd.log'), 'utf8').trim()).toBe(realpathSync(configDir()));
  });

  it('a pasted token wins over the browser sign-in', async () => {
    writeAuth('vca_browser', NOW + 3600);
    const { cred } = make({ valid: ['pasted_tok'] });
    await cred.setVercelToken('pasted_tok');
    expect(await cred.getVercelToken()).toBe('pasted_tok');
    expect((await cred.vercelStatus()).source).toBe('token');
  });
});

describe('setVercelToken', () => {
  it('stores a valid token encrypted', async () => {
    const { cred } = make({ valid: ['pasted_tok'] });
    const status = await cred.setVercelToken('  pasted_tok  ');
    expect(status.connected).toBe(true);
    const raw = readFileSync(pastedFile(), 'utf8');
    expect(raw).not.toContain('pasted_tok');
    expect(raw.startsWith('enc:')).toBe(true);
    expect(statSync(pastedFile()).mode & 0o777).toBe(0o600);
    expect(await cred.getVercelToken()).toBe('pasted_tok');
  });

  it('refuses to store a token when encryption is unavailable (never as plain text)', async () => {
    const calls: ApiCall[] = [];
    const { cred } = make({ valid: ['pasted_tok'], canEncrypt: false, apiCalls: calls });
    await expect(cred.setVercelToken('pasted_tok')).rejects.toMatchObject({ kind: 'encryption-unavailable' });
    expect(existsSync(pastedFile())).toBe(false);
    expect(calls).toEqual([]);
  });

  it('an empty token rejects with kind empty', async () => {
    const { cred } = make();
    await expect(cred.setVercelToken('   ')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('a bad token → connected:false and nothing stored', async () => {
    const { cred } = make({ valid: [] });
    const status = await cred.setVercelToken('bad_tok');
    expect(status.connected).toBe(false);
    expect(existsSync(pastedFile())).toBe(false);
  });
});

describe('vercelStatus', () => {
  it('not connected when there is no token, without calling the API', async () => {
    const calls: ApiCall[] = [];
    const { cred } = make({ apiCalls: calls });
    expect(await cred.vercelStatus()).toEqual({ connected: false });
    expect(calls).toEqual([]);
  });

  it('a revoked token (401/403) → connected:false', async () => {
    writeAuth('vca_revoked', NOW + 3600);
    const calls: ApiCall[] = [];
    const { cred } = make({ valid: [], apiCalls: calls });
    expect((await cred.vercelStatus()).connected).toBe(false);
    expect(calls[0]).toEqual({ url: 'https://api.vercel.com/v2/user', auth: 'Bearer vca_revoked' });
  });

  it('reports unreachable / unavailable as kinds, not text', async () => {
    writeAuth('vca_ok', NOW + 3600);
    const down = make({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    expect(await down.cred.vercelStatus()).toEqual({ connected: false, error: 'unreachable' });
    const err = make({ fetchImpl: (async () => new Response('x', { status: 502 })) as unknown as typeof fetch });
    expect(await err.cred.vercelStatus()).toEqual({ connected: false, error: 'unavailable' });
  });

  it('carries the user id (the org of a personal-account project) and the teams', async () => {
    writeAuth('vca_ok', NOW + 3600);
    const { cred } = make({ valid: ['vca_ok'] });
    const status = await cred.vercelStatus();
    expect(status.user).toEqual({ id: 'u1', username: 'ada', email: 'ada@example.com' });
    expect(status.teams).toEqual([{ id: 't1', slug: 'acme', name: 'Acme' }]);
  });
});

describe('cliPaths', () => {
  it('returns the CLI binary and the private config dir, resolving the binary once per session', async () => {
    const { cred, ensureCli } = make();
    const a = await cred.cliPaths();
    const b = await cred.cliPaths();
    expect(a).toEqual(b);
    expect(a.configDir).toBe(path.join(userData(), 'vercel-cli', 'config'));
    expect(ensureCli).toHaveBeenCalledTimes(1);
  });

  it('passes download progress and the cancel signal to the download', async () => {
    const { cred, ensureCli } = make();
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    await cred.cliPaths({ onProgress, signal });
    expect(ensureCli).toHaveBeenCalledWith(expect.objectContaining({ onProgress, signal }));
  });

  it('isCliInstalled never downloads', async () => {
    const { cred, ensureCli } = make({ installed: false });
    expect(await cred.isCliInstalled()).toBe(false);
    expect(ensureCli).not.toHaveBeenCalled();
  });
});

describe('disconnectVercel', () => {
  it('deletes auth.json and the pasted token without running the CLI', async () => {
    writeAuth('vca_browser', NOW + 3600);
    const { cred } = make({ valid: ['pasted_tok'] });
    await cred.setVercelToken('pasted_tok');
    await cred.disconnectVercel();
    expect(existsSync(authFile())).toBe(false);
    expect(existsSync(pastedFile())).toBe(false);
    expect(await cred.getVercelToken()).toBeNull();
    expect(cliCalls()).toEqual([]);
  });
});
