import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
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
    ).rejects.toThrow(/unsafe/);
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
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
  });


  async function rawTarball(setup: (src: string) => void, args: (src: string) => string[]): Promise<Buffer> {
    const src = path.join(work, `raw-${Math.random().toString(36).slice(2)}`);
    mkdirSync(src, { recursive: true });
    setup(src);
    const out = path.join(work, `raw-${Math.random().toString(36).slice(2)}.tgz`);
    execFileSync('/usr/bin/tar', ['-czPf', out, '-C', src, ...args(src)]);
    return readFileSync(out);
  }
  const rejectedAndClean = async (tgz: Buffer, re: RegExp) => {
    await expect(
      ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: fetchOf(tgz) }),
    ).rejects.toThrow(re);
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
  };

  it('rejects a symlink member', async () => {
    const tgz = await rawTarball(
      (src) => {
        mkdirSync(path.join(src, 'package/bin'), { recursive: true });
        writeFileSync(path.join(src, 'package/bin/real'), 'x');
        symlinkSync('/etc/passwd', path.join(src, 'package/bin/vercel'));
      },
      () => ['package'],
    );
    await rejectedAndClean(tgz, /unexpected entry type/);
  });

  it('rejects a hardlink member', async () => {
    const tgz = await rawTarball(
      (src) => {
        mkdirSync(path.join(src, 'package/bin'), { recursive: true });
        writeFileSync(path.join(src, 'package/bin/real'), 'x');
        linkSync(path.join(src, 'package/bin/real'), path.join(src, 'package/bin/vercel'));
      },
      () => ['package/bin/real', 'package/bin/vercel'],
    );
    await rejectedAndClean(tgz, /unexpected entry type/);
  });

  it('rejects an absolute path member', async () => {
    const tgz = await rawTarball(
      (src) => {
        mkdirSync(path.join(src, 'package/bin'), { recursive: true });
        writeFileSync(path.join(src, 'package/bin/vercel'), 'x');
      },
      (src) => ['package/bin/vercel', path.join(src, 'package/bin/vercel')],
    );
    await rejectedAndClean(tgz, /unsafe/);
  });

  it('rejects a wrong top-level directory', async () => {
    const tgz = await rawTarball(
      (src) => {
        mkdirSync(path.join(src, 'other/bin'), { recursive: true });
        writeFileSync(path.join(src, 'other/bin/vercel'), 'x');
      },
      () => ['other'],
    );
    await rejectedAndClean(tgz, /unsafe/);
  });

  it('rejects a package without the binary', async () => {
    const tgz = makeTarball({ 'package/package.json': '{}' });
    await rejectedAndClean(tgz, /no binary/);
  });

  it('re-downloads when the marker has a different integrity', async () => {
    const tgz = good();
    const calls: string[] = [];
    const o = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: fetchOf(tgz, calls) };
    const bin = await ensureVercelCli(o);
    writeFileSync(path.join(path.dirname(bin), '.verified'), JSON.stringify({ integrity: 'sha512-other', sha256: 'x' }));
    await ensureVercelCli(o);
    expect(calls).toHaveLength(2);
  });

  it('re-downloads when the installed binary was modified', async () => {
    const tgz = good();
    const calls: string[] = [];
    const o = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: fetchOf(tgz, calls) };
    const bin = await ensureVercelCli(o);
    writeFileSync(bin, '#!/bin/sh\necho tampered\n');
    const again = await ensureVercelCli(o);
    expect(calls).toHaveLength(2);
    expect(readFileSync(again, 'utf8')).toContain('echo hi');
  });

  it('re-downloads when the installed binary is a symlink', async () => {
    const tgz = good();
    const calls: string[] = [];
    const o = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: fetchOf(tgz, calls) };
    const bin = await ensureVercelCli(o);
    const real = path.join(work, 'real-copy');
    writeFileSync(real, readFileSync(bin), { mode: 0o755 });
    rmSync(bin);
    symlinkSync(real, bin);
    const again = await ensureVercelCli(o);
    expect(calls).toHaveLength(2);
    expect(statSync(again).isFile()).toBe(true);
    expect(lstatSync(again).isSymbolicLink()).toBe(false);
  });

  it('a failing disk write rejects, and a retry works', async () => {
    const tgz = good();
    const failing = (): Writable =>
      new Writable({
        write(_c, _e, cb) {
          cb(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
        },
      });
    const calls: string[] = [];
    const base = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: fetchOf(tgz, calls) };
    await expect(ensureVercelCli({ ...base, createWriteStream: failing })).rejects.toThrow();
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
    const bin = await ensureVercelCli(base);
    expect(existsSync(bin)).toBe(true);
  });

  function gatedFetch(tgz: Buffer) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.signal) signals.push(init.signal);
      let step = 0;
      const half = Math.floor(tgz.length / 2);
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (step++ === 0) {
            c.enqueue(new Uint8Array(tgz.subarray(0, half)));
            return;
          }
          return gate.then(() => {
            c.enqueue(new Uint8Array(tgz.subarray(half)));
            c.close();
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(tgz.length) } });
    }) as unknown as typeof fetch;
    return { fn, release, signals, calls };
  }
  const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  it('one waiter aborting does not cancel the shared download; every waiter gets progress', async () => {
    const tgz = good();
    const g = gatedFetch(tgz);
    const ctrlA = new AbortController();
    const progA = vi.fn();
    const progB = vi.fn();
    const base = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: g.fn };
    const a = ensureVercelCli({ ...base, signal: ctrlA.signal, onProgress: progA });
    const b = ensureVercelCli({ ...base, onProgress: progB });
    const aErr = a.then(() => null, (e: Error) => e);
    await tick();
    ctrlA.abort();
    expect(await aErr).toBeInstanceOf(Error);
    g.release();
    const bin = await b;
    expect(existsSync(bin)).toBe(true);
    expect(g.calls).toHaveLength(1);
    expect(progB).toHaveBeenCalled();
    expect(progA).toHaveBeenCalled();
  });

  it('aborts the download only when every waiter has aborted', async () => {
    const tgz = good();
    const g = gatedFetch(tgz);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const base = { userDataDir: userData(), arch: 'arm64' as const, pin: pinFor(tgz), fetchImpl: g.fn };
    const a = ensureVercelCli({ ...base, signal: c1.signal }).then(() => null, (e: Error) => e);
    const b = ensureVercelCli({ ...base, signal: c2.signal }).then(() => null, (e: Error) => e);
    await tick();
    c1.abort();
    await tick();
    expect(g.signals[0].aborted).toBe(false);
    c2.abort();
    expect(await a).toBeInstanceOf(Error);
    expect(await b).toBeInstanceOf(Error);
    await tick();
    expect(g.signals[0].aborted).toBe(true);
    expect(readdirSync(path.join(userData(), 'vercel-cli'))).toEqual([]);
  });

  it('removes other version directories but keeps config', async () => {
    const tgz = good();
    const root = path.join(userData(), 'vercel-cli');
    mkdirSync(path.join(root, '0.0.1', 'arm64'), { recursive: true });
    mkdirSync(path.join(root, 'config'), { recursive: true });
    await ensureVercelCli({ userDataDir: userData(), arch: 'arm64', pin: pinFor(tgz), fetchImpl: fetchOf(tgz) });
    expect(readdirSync(root).sort()).toEqual(['1.2.3', 'config']);
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
  it('passes args and config dir; token goes in env, not argv; no default config dir', async () => {
    const binary = fakeBinary('echo "ARGS:$*"; echo "CI=$CI TEL=$VERCEL_TELEMETRY_DISABLED STORE=$VERCEL_TOKEN_STORAGE TOKEN=[$VERCEL_TOKEN]"; pwd');
    const cfg = path.join(work, 'cfg');
    const r = await runVercelCli(['whoami'], { binary, configDir: cfg, cwd: work });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`ARGS:whoami --global-config ${cfg}`);
    expect(r.stdout).not.toContain('--token');
    expect(r.stdout).not.toContain('.vercel');
    expect(r.stdout).not.toContain('com.vercel.cli');
    expect(r.stdout).toContain('CI=1 TEL=1 STORE=file TOKEN=[]');
    const t = await runVercelCli(['whoami'], { binary, configDir: cfg, token: 'sekret' });
    expect(t.stdout).toContain('TOKEN=[sekret]');
    expect(t.stdout).not.toContain('ARGS:whoami --global-config ' + cfg + ' sekret');
    expect(t.stdout).not.toMatch(/ARGS:.*sekret/);
  });

  it('does not pass the parent environment to the child', async () => {
    process.env.VERCEL_TOKEN = 'parent-token';
    process.env.VERCEL_ORG_ID = 'org_parent';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-parent';
    try {
      const binary = fakeBinary('env');
      const r = await runVercelCli([], { binary, configDir: work });
      expect(r.stdout).not.toContain('parent-token');
      expect(r.stdout).not.toContain('org_parent');
      expect(r.stdout).not.toContain('sk-ant-parent');
      expect(r.stdout).toMatch(/^PATH=/m);
      expect(r.stdout).toMatch(/^CI=1$/m);
      expect(r.stdout).toMatch(/^NO_UPDATE_NOTIFIER=1$/m);
    } finally {
      delete process.env.VERCEL_TOKEN;
      delete process.env.VERCEL_ORG_ID;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('resolves when the CLI exits leaving a background child holding stdout, and kills it', async () => {
    const pidFile = path.join(work, 'bg.pid');
    const binary = fakeBinary(`sleep 60 & echo $! > "${pidFile}"; echo done`);
    const r = await Promise.race([
      runVercelCli([], { binary, configDir: work }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('hung')), 4000)),
    ]);
    expect(r.stdout).toContain('done');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 10_000);

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

  async function waitFor(check: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  }
  const pidReady = (f: string) => () => existsSync(f) && /^\d+\s*$/.test(readFileSync(f, 'utf8'));

  it('kills the whole process group on timeout, without leaking the token', async () => {
    const { p, pidFile } = await groupDemo({ timeoutMs: 2500 });
    await waitFor(pidReady(pidFile), 2000);
    const err = await p.then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/timed out/);
    expect(err?.message).not.toContain('sekret-token');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('kills the group on abort', async () => {
    const ctrl = new AbortController();
    const { p, pidFile } = await groupDemo({ signal: ctrl.signal });
    await waitFor(pidReady(pidFile));
    ctrl.abort();
    const err = await p.then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/cancelled/);
    expect(err?.message).not.toContain('sekret-token');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('a missing binary rejects without the token', async () => {
    const err = await runVercelCli([], { binary: path.join(work, 'nope'), configDir: work, token: 'sekret-token' }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/could not be started/);
    expect(err?.message).not.toContain('sekret-token');
  });
});
