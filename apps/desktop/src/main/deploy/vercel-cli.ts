/**
 * The Vercel CLI: downloaded on first use (pinned native package from the npm
 * registry, checked against a pinned sha512 before anything is extracted) and
 * run directly as a child process in its own process group.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { finished, pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
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
  /** Tests only: where the tarball is written. */
  createWriteStream?: (file: string) => Writable;
}

interface Inflight {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
  progress: Set<(received: number, total: number) => void>;
}

const inflight = new Map<string, Inflight>();

export function ensureVercelCli(opts: EnsureVercelCliOptions): Promise<string> {
  const pin = opts.pin ?? VERCEL_CLI;
  const arch = opts.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const root = path.join(opts.userDataDir, 'vercel-cli');
  const key = `${root}\0${pin.version}\0${arch}`;
  if (opts.signal?.aborted) return Promise.reject(new Error('Vercel CLI download aborted'));

  let entry = inflight.get(key);
  if (!entry) {
    const controller = new AbortController();
    const progress = new Set<(received: number, total: number) => void>();
    const created: Inflight = { promise: Promise.resolve(''), controller, waiters: 0, progress };
    created.promise = doEnsure(opts, pin, arch, root, controller.signal, (r, t) => {
      for (const fn of progress) fn(r, t);
    }).finally(() => {
      if (inflight.get(key) === created) inflight.delete(key);
    });
    created.promise.catch(() => undefined);
    inflight.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.waiters += 1;
  if (opts.onProgress) shared.progress.add(opts.onProgress);

  return new Promise<string>((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) return;
      done = true;
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.onProgress) shared.progress.delete(opts.onProgress);
    };
    const onAbort = () => {
      if (done) return;
      leave();
      shared.waiters -= 1;
      if (shared.waiters <= 0) shared.controller.abort();
      reject(new Error('Vercel CLI download aborted'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (v) => {
        if (done) return;
        leave();
        resolve(v);
      },
      (e) => {
        if (done) return;
        leave();
        reject(e);
      },
    );
  });
}

interface Marker {
  integrity: string;
  sha256: string;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Trusts an installed binary only if it is a regular file whose hash matches the marker. */
async function installedBinary(finalDir: string, binary: string, integrity: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(finalDir, MARKER), 'utf8')) as Marker;
    if (marker.integrity !== integrity) return false;
    const st = await fs.lstat(binary);
    if (!st.isFile() || (st.mode & 0o111) === 0) return false;
    return (await sha256File(binary)) === marker.sha256;
  } catch {
    return false;
  }
}

async function doEnsure(
  opts: EnsureVercelCliOptions,
  pin: VercelCliPin,
  arch: 'arm64' | 'x64',
  root: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  const pkg = pin.packages[arch];
  const finalDir = path.join(root, pin.version, arch);
  const binary = path.join(finalDir, 'vercel');
  if (await installedBinary(finalDir, binary, pkg.integrity)) return binary;

  await fs.mkdir(root, { recursive: true });
  const stage = path.join(root, `.tmp-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(stage);
  try {
    const tgz = path.join(stage, 'package.tgz');
    await download(opts, pin, pkg, tgz, signal, onProgress);
    const extractDir = path.join(stage, 'x');
    await fs.mkdir(extractDir);
    await extractBinary(tgz, extractDir, signal);
    const extracted = path.join(extractDir, ...BINARY_IN_TARBALL.split('/'));
    const st = await fs.lstat(extracted);
    if (!st.isFile()) throw new Error('Vercel CLI package: binary is not a regular file');
    await fs.chmod(extracted, 0o755);
    const ready = path.join(stage, 'ready');
    await fs.mkdir(ready);
    await fs.rename(extracted, path.join(ready, 'vercel'));
    const marker: Marker = { integrity: pkg.integrity, sha256: await sha256File(path.join(ready, 'vercel')) };
    await fs.writeFile(path.join(ready, MARKER), JSON.stringify(marker));
    await fs.mkdir(path.dirname(finalDir), { recursive: true });
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(ready, finalDir);
    await removeOtherVersions(root, pin.version);
    return binary;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeOtherVersions(root: string, keep: string): Promise<void> {
  const names = await fs.readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (name === keep || name === 'config' || name.startsWith('.tmp-')) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
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
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const url = tarballUrl(opts.registry ?? 'https://registry.npmjs.org', pkg.name, pin.version);
  const out = opts.createWriteStream ? opts.createWriteStream(dest) : createWriteStream(dest);
  let onAbort: (() => void) | undefined;
  const failed = new Promise<never>((_, reject) => {
    out.once('error', reject);
    onAbort = () => reject(new Error('Vercel CLI download aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  failed.catch(() => undefined);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await Promise.race([f(url, { signal }), failed]);
    if (!res.ok || !res.body) throw new Error(`Vercel CLI download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const hash = createHash('sha512');
    reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) {
        await Promise.race([new Promise<void>((r) => out.once('drain', r)), failed]);
      }
      onProgress(received, total);
    }
    out.end();
    await Promise.race([finished(out), failed]);
    if (`sha512-${hash.digest('base64')}` !== pkg.integrity) {
      throw new Error('Vercel CLI download failed the integrity check');
    }
  } catch (err) {
    await reader?.cancel().catch(() => undefined);
    out.destroy();
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
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

function buildEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR' || k === 'LANG' || k.startsWith('LC_')) env[k] = v;
  }
  env.CI = '1';
  env.VERCEL_TELEMETRY_DISABLED = '1';
  env.VERCEL_TOKEN_STORAGE = 'file';
  env.NO_UPDATE_NOTIFIER = '1';
  if (token) env.VERCEL_TOKEN = token;
  return env;
}

export function runVercelCli(args: string[], opts: RunVercelCliOptions): Promise<RunVercelCliResult> {
  return new Promise((resolve, reject) => {
    const fullArgs = [...args, '--global-config', opts.configDir];
    const child = spawn(opts.binary, fullArgs, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildEnv(opts.token),
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
    // a straggler holding stdio must not keep the call waiting
    child.once('exit', killGroup);
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
