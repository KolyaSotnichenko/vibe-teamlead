import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureVercelCli, runVercelCli, VERCEL_CLI, type VercelCliPin } from '../vercel-cli';

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'vc-cli-test-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function makeTarball(files: Record<string, string>, mode = 0o755): Buffer {
  const src = path.join(work, 'src');
  mkdirSync(src, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(src, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body, { mode });
  }
  const out = path.join(work, 'fixture.tgz');
  execFileSync('/usr/bin/tar', ['-czf', out, '-C', src, ...Object.keys(files).map((k) => k.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)]);
  return readFileSync(out);
}

function pinFor(tgz: Buffer): VercelCliPin {
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const pkg = { name: '@vercel/vc-native-darwin-arm64', integrity };
  return { version: '1.2.3', packages: { arm64: pkg, x64: pkg } };
}

function fetchOf(tgz: Buffer, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    return new Response(new Uint8Array(tgz), { status: 200, headers: { 'content-length': String(tgz.length) } });
  }) as unknown as typeof fetch;
}

const good = () => makeTarball({ 'package/bin/vercel': '#!/bin/sh\necho hi\n', 'package/package.json': '{}' });
const userData = () => path.join(work, 'userData');

describe('pin', () => {
  it('has sha512 integrity for both archs', () => {
    expect(VERCEL_CLI.version).toBe('65.14.0');
    for (const a of ['arm64', 'x64'] as const) {
      expect(VERCEL_CLI.packages[a].name).toBe(`@vercel/vc-native-darwin-${a}`);
      expect(VERCEL_CLI.packages[a].integrity).toMatch(/^sha512-/);
    }
  });
});

describe('ensureVercelCli', () => {
  it('installs a verified binary, executable, and a second call does not fetch', async () => {
    const tgz = good();
    const calls: string[] = [];
    const progress = vi.fn();
    const bin = await ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: fetchOf(tgz, calls), onProgress: progress });
    expect(path.isAbsolute(bin)).toBe(true);
    expect(bin.startsWith(path.join(userData(), 'vercel-cli', '1.2.3'))).toBe(true);
    expect(statSync(bin).mode & 0o111).toBeTruthy();
    expect(calls).toEqual(['https://registry.npmjs.org/@vercel/vc-native-darwin-arm64/-/vc-native-darwin-arm64-1.2.3.tgz']);
    expect(progress).toHaveBeenCalled();
    const again = await ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: fetchOf(tgz, calls) });
    expect(again).toBe(bin);
    expect(calls).toHaveLength(1);
    expect(readdirSync(path.join(userData(), 'vercel-cli')).filter((n) => n.startsWith('.tmp'))).toEqual([]);
  });

  it('rejects an integrity mismatch and leaves nothing behind', async () => {
    const tgz = good();
    const other = makeTarball({ 'package/bin/vercel': 'evil' });
    await expect(
      ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: fetchOf(other) }),
    ).rejects.toThrow(/integrity/);
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
  });

  it('rejects a package with a path escape even with a matching hash', async () => {
    const src = path.join(work, 'evil');
    mkdirSync(path.join(src, 'package', 'bin'), { recursive: true });
    writeFileSync(path.join(src, 'package', 'bin', 'vercel'), 'x');
    const out = path.join(work, 'evil.tgz');
    // bsdtar -P keeps the ".." member name
    writeFileSync(path.join(work, 'outside'), 'x');
    execFileSync('/usr/bin/tar', ['-czPf', out, '-C', src, 'package/bin/vercel', '../outside']);
    const tgz = readFileSync(out);
    await expect(
      ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: fetchOf(tgz) }),
    ).rejects.toThrow(/unsafe|unpacked/);
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
  });

  it('shares one download between concurrent calls', async () => {
    const tgz = good();
    const calls: string[] = [];
    const f = fetchOf(tgz, calls);
    const opts = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: f };
    const [a, b] = await Promise.all([ensureVercelCli(opts), ensureVercelCli(opts)]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it('cleans up when aborted mid-download', async () => {
    const tgz = good();
    const ctrl = new AbortController();
    const f = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(tgz.subarray(0, 10)));
          setTimeout(() => ctrl.abort(), 10);
        },
        pull() {
          return new Promise(() => undefined);
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: f, signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
  });

  it('fails on an HTTP error', async () => {
    const tgz = good();
    const f = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: f })).rejects.toThrow(/404/);
  });
});

function fakeBinary(body: string): string {
  const f = path.join(work, `fake-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return f;
}

describe('runVercelCli', () => {
  it('passes args, config dir, env, and the token flag only when given', async () => {
    const binary = fakeBinary('echo "ARGS:$*"; echo "CI=$CI TEL=$VERCEL_TELEMETRY_DISABLED STORE=$VERCEL_TOKEN_STORAGE"; pwd');
    const cfg = path.join(work, 'cfg');
    const r = await runVercelCli(['whoami'], { binary, configDir: cfg, cwd: work });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`ARGS:whoami --global-config ${cfg}`);
    expect(r.stdout).not.toContain('--token');
    expect(r.stdout).toContain('CI=1 TEL=1 STORE=file');
    const t = await runVercelCli(['whoami'], { binary, configDir: cfg, token: 'sekret' });
    expect(t.stdout).toContain('--token sekret');
  });

  it('reports exit codes, stderr and lines', async () => {
    const binary = fakeBinary('echo one; echo two >&2; exit 3');
    const lines: string[] = [];
    const r = await runVercelCli([], { binary, configDir: work, onOutput: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('two');
    expect(lines.sort()).toEqual(['one', 'two']);
  });

  it('ignores stdin', async () => {
    const binary = fakeBinary('read x; echo "got:[$x]"');
    const r = await runVercelCli([], { binary, configDir: work });
    expect(r.stdout).toContain('got:[]');
  });

  async function groupDemo(extra: { timeoutMs?: number; signal?: AbortSignal }) {
    const pidFile = path.join(work, 'child.pid');
    const binary = fakeBinary(`sleep 60 & echo $! > "${pidFile}"; wait`);
    const p = runVercelCli(['x'], { binary, configDir: work, token: 'sekret-token', ...extra });
    return { p, pidFile };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('kills the whole process group on timeout, without leaking the token', async () => {
    const { p, pidFile } = await groupDemo({ timeoutMs: 400 });
    const err = await p.then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/timed out/);
    expect(err?.message).not.toContain('sekret-token');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(pidFile) && alive(pid)).toBe(false);
  });

  it('kills the group on abort', async () => {
    const ctrl = new AbortController();
    const { p, pidFile } = await groupDemo({ signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 300);
    const err = await p.then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/cancelled/);
    expect(err?.message).not.toContain('sekret-token');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it('a missing binary rejects without the token', async () => {
    const err = await runVercelCli([], { binary: path.join(work, 'nope'), configDir: work, token: 'sekret-token' }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('sekret-token');
  });
});
