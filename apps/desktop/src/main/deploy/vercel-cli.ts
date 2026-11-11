/**
 * The Vercel CLI: downloaded on first use (pinned native package from the npm
 * registry, checked against a pinned sha512 before anything is extracted) and
 * run directly as a child process in its own process group.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

export interface VercelCliPackage {
  name: string;
  integrity: string;
}

export interface VercelCliPin {
  version: string;
  packages: { arm64: VercelCliPackage; x64: VercelCliPackage };
}

export const VERCEL_CLI: VercelCliPin = {
  version: '65.14.0',
  packages: {
    arm64: {
      name: '@vercel/vc-native-darwin-arm64',
      integrity:
        'sha512-6PntrudPppo6vTcZ+ZKow76vQ2dWXHqRXsxmtj2owqJHh7EIrcQ+w+kNfVzokT+Pdi3YVUBTsJwFyMd0C06JLA==',
    },
    x64: {
      name: '@vercel/vc-native-darwin-x64',
      integrity:
        'sha512-2thgFRinrzOk6E/ow4OeTY5hZDekoZyNrnertQTQRdSOK0fI4/0guiOOFPGfooblvL4j9RQvr+dEaESgxCLBLA==',
    },
  },
};

/** The one file we take from the package tarball. */
const BINARY_IN_TARBALL = 'package/bin/vercel';
const MARKER = '.verified';

export interface EnsureVercelCliOptions {
  userDataDir: string;
  arch?: 'arm64' | 'x64';
  fetchImpl?: typeof fetch;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
  /** Tests only: a different pin. */
  pin?: VercelCliPin;
  /** Tests only: a different registry origin. */
  registry?: string;
}

const inflight = new Map<string, Promise<string>>();

export function ensureVercelCli(opts: EnsureVercelCliOptions): Promise<string> {
  const pin = opts.pin ?? VERCEL_CLI;
  const arch = opts.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const root = path.join(opts.userDataDir, 'vercel-cli');
  const key = `${root}\0${pin.version}\0${arch}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = doEnsure(opts, pin, arch, root).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doEnsure(
  opts: EnsureVercelCliOptions,
  pin: VercelCliPin,
  arch: 'arm64' | 'x64',
  root: string,
): Promise<string> {
  const pkg = pin.packages[arch];
  const finalDir = path.join(root, pin.version, arch);
  const binary = path.join(finalDir, 'vercel');
  try {
    const marker = await fs.readFile(path.join(finalDir, MARKER), 'utf8');
    if (marker.trim() === pkg.integrity) {
      await fs.access(binary);
      return binary;
    }
  } catch {
    // not installed yet
  }

  await fs.mkdir(root, { recursive: true });
  const stage = path.join(root, `.tmp-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(stage);
  try {
    const tgz = path.join(stage, 'package.tgz');
    await download(opts, pin, pkg, tgz);
    const extractDir = path.join(stage, 'x');
    await fs.mkdir(extractDir);
    await extractBinary(tgz, extractDir, opts.signal);
    const extracted = path.join(extractDir, ...BINARY_IN_TARBALL.split('/'));
    const st = await fs.lstat(extracted);
    if (!st.isFile()) throw new Error('Vercel CLI package: binary is not a regular file');
    await fs.chmod(extracted, 0o755);
    const ready = path.join(stage, 'ready');
    await fs.mkdir(ready);
    await fs.rename(extracted, path.join(ready, 'vercel'));
    await fs.writeFile(path.join(ready, MARKER), pkg.integrity);
    await fs.mkdir(path.dirname(finalDir), { recursive: true });
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(ready, finalDir);
    return binary;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

function tarballUrl(registry: string, name: string, version: string): string {
  const base = name.split('/').pop() as string;
  return `${registry}/${name}/-/${base}-${version}.tgz`;
}

async function download(
  opts: EnsureVercelCliOptions,
  pin: VercelCliPin,
  pkg: VercelCliPackage,
  dest: string,
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const url = tarballUrl(opts.registry ?? 'https://registry.npmjs.org', pkg.name, pin.version);
  const res = await f(url, { signal: opts.signal });
  if (!res.ok || !res.body) throw new Error(`Vercel CLI download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha512');
  const out = createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('Vercel CLI download aborted'));
    if (opts.signal?.aborted) fail();
    else opts.signal?.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('Vercel CLI download aborted');
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
      opts.onProgress?.(received, total);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    out.destroy();
    throw err;
  }
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
  const got = `sha512-${hash.digest('base64')}`;
  if (got !== pkg.integrity) {
    throw new Error('Vercel CLI download failed the integrity check');
  }
}

function runTar(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/tar',
      args,
      { cwd, signal, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(new Error('Vercel CLI package could not be unpacked')) : resolve(stdout)),
    );
  });
}

/** Lists the archive first: only plain files and directories under package/, no escapes. */
async function extractBinary(tgz: string, dir: string, signal?: AbortSignal): Promise<void> {
  const names = (await runTar(['-tzf', tgz], dir, signal)).split('\n').filter(Boolean);
  const types = (await runTar(['-tvzf', tgz], dir, signal))
    .split('\n')
    .filter(Boolean)
    .map((l) => l[0]);
  if (names.length !== types.length) throw new Error('Vercel CLI package listing is inconsistent');
  let found = false;
  names.forEach((name, i) => {
    const type = types[i];
    const segments = name.split('/');
    if (type !== '-' && type !== 'd') throw new Error('Vercel CLI package has an unexpected entry type');
    if (name.startsWith('/') || segments.includes('..') || segments[0] !== 'package') {
      throw new Error('Vercel CLI package has an unsafe path');
    }
    if (name === BINARY_IN_TARBALL && type === '-') found = true;
  });
  if (!found) throw new Error('Vercel CLI package has no binary');
  await runTar(['-xzf', tgz, '--no-same-owner', BINARY_IN_TARBALL], dir, signal);
}

export interface RunVercelCliOptions {
  binary: string;
  configDir: string;
  token?: string;
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunVercelCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runVercelCli(args: string[], opts: RunVercelCliOptions): Promise<RunVercelCliResult> {
  return new Promise((resolve, reject) => {
    const fullArgs = [...args, '--global-config', opts.configDir];
    if (opts.token) fullArgs.push('--token', opts.token);
    const child = spawn(opts.binary, fullArgs, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        VERCEL_TELEMETRY_DISABLED: '1',
        VERCEL_TOKEN_STORAGE: 'file',
        NO_UPDATE_NOTIFIER: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let failure: Error | null = null;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };
    const fail = (message: string) => {
      failure ??= new Error(message);
      killGroup();
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => fail(`Vercel CLI timed out after ${opts.timeoutMs} ms`), opts.timeoutMs)
        : undefined;
    const onAbort = () => fail('Vercel CLI run was cancelled');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const lineBuffers = { out: '', err: '' };
    const feed = (which: 'out' | 'err', chunk: string) => {
      if (!opts.onOutput) return;
      const buf = (lineBuffers[which] + chunk).split('\n');
      lineBuffers[which] = buf.pop() ?? '';
      for (const l of buf) opts.onOutput(l);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
      feed('out', c);
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
      feed('err', c);
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.once('error', () => finish(() => reject(new Error('Vercel CLI could not be started'))));
    child.once('close', (code) => {
      // the group may hold stragglers even after a normal exit
      killGroup();
      for (const w of ['out', 'err'] as const) {
        if (lineBuffers[w]) opts.onOutput?.(lineBuffers[w]);
      }
      finish(() => (failure ? reject(failure) : resolve({ code: code ?? 1, stdout, stderr })));
    });
  });
}
