import { describe, it, expect, vi } from 'vitest';
import { execFileSync, execFile } from 'child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sodium from 'libsodium-wrappers';
import {
  createPrivateRepo,
  pushWithAppToken,
  addOriginIfMissing,
  setRepoSecret,
  repoVisibility,
  getAuthenticatedLogin,
  inspectRepo,
  isValidSecretName,
  type GitRunner,
} from '../github-write';

type Call = { url: string; method: string; body?: unknown; auth?: string };

function fakeFetch(handler: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>)?.Authorization,
    };
    calls.push(call);
    const r = handler(call);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(),
      json: async () => r.body ?? {},
    } as unknown as Response;
  });
  return { impl, calls };
}
const getToken = async () => 'tok_SECRET';

describe('createPrivateRepo', () => {
  it('creates a private repo without auto_init', async () => {
    const f = fakeFetch(() => ({
      status: 201,
      body: { name: 'app', owner: { login: 'me' }, clone_url: 'https://github.com/me/app.git' },
    }));
    const r = await createPrivateRepo('app', { fetchImpl: f.impl, getToken });
    expect(r).toEqual({ owner: 'me', repo: 'app', cloneUrl: 'https://github.com/me/app.git' });
    expect(f.calls[0].url).toBe('https://api.github.com/user/repos');
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].body).toEqual({ name: 'app', private: true, auto_init: false });
    expect(f.calls[0].auth).toBe('Bearer tok_SECRET');
  });

  it('retries with -2, -3 when the name exists', async () => {
    const f = fakeFetch((c) => {
      const name = (c.body as { name: string }).name;
      if (name === 'app' || name === 'app-2') {
        return { status: 422, body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] } };
      }
      return { status: 201, body: { name, owner: { login: 'me' }, clone_url: `https://github.com/me/${name}.git` } };
    });
    const r = await createPrivateRepo('app', { fetchImpl: f.impl, getToken });
    expect(r.repo).toBe('app-3');
    expect(f.calls.map((c) => (c.body as { name: string }).name)).toEqual(['app', 'app-2', 'app-3']);
  });

  it('gives up after 5 tries', async () => {
    const f = fakeFetch(() => ({ status: 422, body: { errors: [{ message: 'name already exists on this account' }] } }));
    await expect(createPrivateRepo('app', { fetchImpl: f.impl, getToken })).rejects.toMatchObject({ kind: 'conflict' });
    expect(f.calls).toHaveLength(5);
    expect((f.calls[4].body as { name: string }).name).toBe('app-5');
  });

  it('classifies 403 as permissions with the approve hint', async () => {
    const f = fakeFetch(() => ({ status: 403, body: { message: 'Resource not accessible by integration' } }));
    const err = await createPrivateRepo('app', { fetchImpl: f.impl, getToken }).catch((e) => e);
    expect(err.kind).toBe('permissions');
    expect(err.message).toMatch(/approve/i);
  });

  it('does not retry on other 422 errors and never leaks the token', async () => {
    const f = fakeFetch(() => ({ status: 422, body: { message: 'Repository name is invalid' } }));
    const err = await createPrivateRepo('bad name', { fetchImpl: f.impl, getToken }).catch((e) => e);
    expect(f.calls).toHaveLength(1);
    expect(String(err.message)).not.toContain('tok_SECRET');
  });

  it('fails with no-connection when not signed in', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const err = await createPrivateRepo('app', { fetchImpl: f.impl, getToken: async () => null }).catch((e) => e);
    expect(err.kind).toBe('no-connection');
    expect(f.calls).toHaveLength(0);
  });
});

describe('createPrivateRepo edge cases', () => {
  it('maps a network failure to unavailable', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await createPrivateRepo('app', { fetchImpl: impl as never, getToken }).catch((e) => e);
    expect(err).toMatchObject({ name: 'GitHubWriteError', kind: 'unavailable' });
  });

  it('keeps name plus suffix within 100 characters', async () => {
    const long = 'a'.repeat(120);
    const f = fakeFetch((c) => {
      const name = (c.body as { name: string }).name;
      return name.length === 100 && !name.endsWith('-2')
        ? { status: 422, body: { errors: [{ message: 'name already exists on this account' }] } }
        : { status: 201, body: { name, owner: { login: 'me' }, clone_url: 'x' } };
    });
    const r = await createPrivateRepo(long, { fetchImpl: f.impl, getToken });
    for (const c of f.calls) expect((c.body as { name: string }).name.length).toBeLessThanOrEqual(100);
    expect(r.repo.endsWith('-2')).toBe(true);
  });
});

describe('repoVisibility', () => {
  it('maps private flag', async () => {
    const a = fakeFetch(() => ({ status: 200, body: { private: true } }));
    expect(await repoVisibility('me', 'app', { fetchImpl: a.impl, getToken })).toBe('private');
    expect(a.calls[0].url).toBe('https://api.github.com/repos/me/app');
    const b = fakeFetch(() => ({ status: 200, body: { private: false } }));
    expect(await repoVisibility('me', 'app', { fetchImpl: b.impl, getToken })).toBe('public');
  });
});

describe('getAuthenticatedLogin', () => {
  it('returns the login of the token user', async () => {
    const a = fakeFetch(() => ({ status: 200, body: { login: 'nick' } }));
    expect(await getAuthenticatedLogin({ fetchImpl: a.impl, getToken })).toBe('nick');
    expect(a.calls[0].url).toBe('https://api.github.com/user');
  });
  it('classified error on failure', async () => {
    const a = fakeFetch(() => ({ status: 500 }));
    await expect(getAuthenticatedLogin({ fetchImpl: a.impl, getToken })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('inspectRepo', () => {
  it('private flag, created_at and emptiness from /branches', async () => {
    const a = fakeFetch((c) =>
      c.url.endsWith('/branches?per_page=1')
        ? { status: 200, body: [] }
        : { status: 200, body: { private: true, created_at: '2026-11-11T10:00:00Z' } },
    );
    expect(await inspectRepo('me', 'app', { fetchImpl: a.impl, getToken })).toEqual({ private: true, createdAt: '2026-11-11T10:00:00Z', empty: true });
    expect(a.calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/me/app', 'https://api.github.com/repos/me/app/branches?per_page=1']);
  });
  it('not empty when a branch exists; null on 404', async () => {
    const a = fakeFetch((c) =>
      c.url.endsWith('/branches?per_page=1') ? { status: 200, body: [{ name: 'main' }] } : { status: 200, body: { private: true, created_at: 'x' } },
    );
    expect((await inspectRepo('me', 'app', { fetchImpl: a.impl, getToken }))?.empty).toBe(false);
    const b = fakeFetch(() => ({ status: 404 }));
    expect(await inspectRepo('me', 'gone', { fetchImpl: b.impl, getToken })).toBeNull();
  });
});

describe('setRepoSecret', () => {
  it('validates names', () => {
    expect(isValidSecretName('DATABASE_URL')).toBe(true);
    expect(isValidSecretName('_X1')).toBe(true);
    expect(isValidSecretName('lower')).toBe(false);
    expect(isValidSecretName('1ABC')).toBe(false);
    expect(isValidSecretName('GITHUB_TOKEN')).toBe(false);
    expect(isValidSecretName('A-B')).toBe(false);
  });

  it('rejects an invalid name before any request', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    await expect(setRepoSecret('me', 'app', 'GITHUB_X', 'v', { fetchImpl: f.impl, getToken })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it('seals the value so the matching key decrypts it exactly', async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const value = 'pa"ss\'wörd 🔑\nline2 \\ end\n';
    const f = fakeFetch((c) =>
      c.method === 'GET'
        ? { status: 200, body: { key_id: 'k1', key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) } }
        : { status: 204 },
    );
    await setRepoSecret('me', 'app', 'MY_SECRET', value, { fetchImpl: f.impl, getToken });
    expect(f.calls[0].url).toBe('https://api.github.com/repos/me/app/actions/secrets/public-key');
    const put = f.calls[1];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://api.github.com/repos/me/app/actions/secrets/MY_SECRET');
    const body = put.body as { encrypted_value: string; key_id: string };
    expect(body.key_id).toBe('k1');
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey,
    );
    expect(sodium.to_string(opened)).toBe(value);
    expect(JSON.stringify(put)).not.toContain('pa"ss');
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

const INCLUDE_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'gw-inc-')), 'extra.cfg');
writeFileSync(INCLUDE_FILE, '[x]\n\ty = 1\n');
const URL_OK = 'https://github.com/me/app.git';
const BASIC = Buffer.from('x-access-token:tok_SECRET').toString('base64');

function envPairs(env: Record<string, string | undefined>): Record<string, string> {
  const n = Number(env.GIT_CONFIG_COUNT);
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[env[`GIT_CONFIG_KEY_${i}`] as string] = env[`GIT_CONFIG_VALUE_${i}`] as string;
  return out;
}

describe('push and origin (real local bare remote)', () => {
  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), 'gw-'));
    const bare = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-b', 'main', work]);
    git(work, 'config', 'user.email', 't@t');
    git(work, 'config', 'user.name', 't');
    writeFileSync(path.join(work, 'a.txt'), 'a');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'init');
    return { bare, work, root };
  }
  type Rec = { args: string[]; cwd: string; env: Record<string, string | undefined>; hooksDirExisted?: boolean; tempConfig?: string };
  /** Records the call, redirects the github URL to the local bare repo via one extra env config pair (test only), runs real git. */
  function recordingRunner(calls: Rec[], redirectTo?: string): GitRunner {
    return (_file, args, opts) =>
      new Promise((resolve, reject) => {
        const rec: Rec = { args, cwd: opts.cwd, env: opts.env };
        const hp = envPairs(opts.env)['core.hooksPath'];
        rec.hooksDirExisted = hp ? existsSync(hp) : undefined;
        const gd = args.find((a) => a.startsWith('--git-dir='))?.slice('--git-dir='.length);
        if (gd) rec.tempConfig = readFileSync(path.join(gd, 'config'), 'utf-8');
        calls.push(rec);
        const env = { ...opts.env } as Record<string, string | undefined>;
        if (redirectTo) {
          const n = Number(env.GIT_CONFIG_COUNT);
          env[`GIT_CONFIG_KEY_${n}`] = `url.${redirectTo}.insteadOf`;
          env[`GIT_CONFIG_VALUE_${n}`] = URL_OK;
          env.GIT_CONFIG_COUNT = String(n + 1);
        }
        execFile('git', args, { cwd: opts.cwd, env: env as NodeJS.ProcessEnv }, (e, stdout, stderr) =>
          e ? reject(Object.assign(e, { stderr })) : resolve(String(stdout)),
        );
      });
  }
  const head = (d: string, ref = 'HEAD') => git(d, 'rev-parse', ref).trim();

  it('pushes the resolved sha from a private temp repo; token only in env config; project untouched', async () => {
    const { bare, work } = setup();
    const before = readFileSync(path.join(work, '.git', 'config'), 'utf-8');
    const sha = head(work);
    const calls: Rec[] = [];
    await pushWithAppToken(work, URL_OK, 'main:refs/heads/main', { getToken, runner: recordingRunner(calls, bare) });
    expect(head(bare, 'refs/heads/main')).toBe(sha);
    expect(calls).toHaveLength(1);
    const { args, env, hooksDirExisted, cwd } = calls[0];
    const gitDirArg = args[0];
    expect(gitDirArg).toMatch(/^--git-dir=.*vt-push-/);
    expect(args.slice(1)).toEqual(['push', '--no-verify', '--', URL_OK, `${sha}:refs/heads/main`]);
    expect(cwd).not.toBe(work);
    expect(args.join(' ')).not.toContain('tok_SECRET');
    expect(args.join(' ')).not.toContain(BASIC);
    const pairs = envPairs(env);
    expect(pairs['credential.helper']).toBe('');
    expect(pairs['http.https://github.com/.extraheader']).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(pairs['http.followRedirects']).toBe('false');
    expect(pairs['http.sslVerify']).toBe('true');
    expect(pairs['push.gpgSign']).toBe('false');
    const hooks = pairs['core.hooksPath'];
    expect(hooksDirExisted).toBe(true);
    expect(Object.keys(pairs)).toHaveLength(6);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_TRACE_REDACT).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith('GIT_CONFIG_VALUE_') && v === `AUTHORIZATION: basic ${BASIC}`) continue;
      expect(String(v)).not.toContain('tok_SECRET');
      expect(String(v)).not.toContain(BASIC);
    }
    // the temp repo's own config is git's bare-init default only, and it is gone afterwards
    expect(calls[0].tempConfig).not.toMatch(/http|url|credential|include|gpg|fsmonitor/i);
    expect(existsSync(hooks)).toBe(false);
    expect(existsSync(gitDirArg.slice('--git-dir='.length))).toBe(false);
    expect(readFileSync(path.join(work, '.git', 'config'), 'utf-8')).toBe(before);
    expect(readFileSync(path.join(bare, 'config'), 'utf-8')).not.toContain('tok_SECRET');
  });

  it('never reads the project config or hooks: risky settings and scripts have no effect', async () => {
    const { bare, work, root } = setup();
    const marker = path.join(root, 'ran.txt');
    const script = path.join(root, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $@" >> "${marker}"\nenv >> "${marker}"\ncat >/dev/null\nexit 1\n`);
    chmodSync(script, 0o755);
    const inc = path.join(root, 'inc.cfg');
    writeFileSync(inc, `[core]\n\tfsmonitor = ${script}\n`);
    const set = (...a: string[]) => git(work, 'config', '--local', ...a);
    set('http.proxy', 'http://127.0.0.1:9');
    set('http.sslVerify', 'false');
    set('url.https://evil.invalid/.insteadOf', 'https://github.com/');
    set('url.https://evil.invalid/.pushInsteadOf', 'https://github.com/');
    set('include.path', inc);
    set('includeIf.gitdir:/**.path', inc);
    set('core.fsmonitor', script);
    set('core.sshCommand', script);
    set('gpg.program', script);
    set('push.gpgSign', 'true');
    set('credential.helper', `!${script}`);
    set('remote.origin.vcs', 'evil');
    set('remote.origin.url', 'https://evil.invalid/x.git');
    set('extensions.worktreeConfig', 'true');
    git(work, 'config', '--worktree', 'http.proxy', 'http://127.0.0.1:9');
    for (const hook of ['pre-push', 'reference-transaction', 'post-commit']) {
      const f = path.join(work, '.git', 'hooks', hook);
      writeFileSync(f, `#!/bin/sh\nenv >> "${marker}"\ncat >/dev/null\n`);
      chmodSync(f, 0o755);
    }
    const sha = head(work);
    await pushWithAppToken(work, URL_OK, 'main', { getToken, runner: recordingRunner([], bare) });
    expect(head(bare, 'refs/heads/main')).toBe(sha);
    expect(existsSync(marker)).toBe(false);
  });

  it('control: the same project does run its hook under a plain push (the isolation test is meaningful)', () => {
    const { bare, work, root } = setup();
    const marker = path.join(root, 'ran.txt');
    const f = path.join(work, '.git', 'hooks', 'pre-push');
    writeFileSync(f, `#!/bin/sh\nenv >> "${marker}"\ncat >/dev/null\n`);
    chmodSync(f, 0o755);
    execFileSync('git', ['push', bare, 'main'], { cwd: work });
    expect(existsSync(marker)).toBe(true);
  });

  it('resolves a branch from packed-refs', async () => {
    const { bare, work } = setup();
    git(work, 'pack-refs', '--all');
    expect(existsSync(path.join(work, '.git', 'refs', 'heads', 'main'))).toBe(false);
    const sha = head(work);
    await pushWithAppToken(work, URL_OK, 'main', { getToken, runner: recordingRunner([], bare) });
    expect(head(bare, 'refs/heads/main')).toBe(sha);
  });

  it('resolves HEAD and a src:dst refspec', async () => {
    const { bare, work } = setup();
    const sha = head(work);
    await pushWithAppToken(work, URL_OK, 'HEAD:refs/heads/deploy', { getToken, runner: recordingRunner([], bare) });
    expect(head(bare, 'refs/heads/deploy')).toBe(sha);
  });

  it('works for a linked-worktree project path (common dir, own HEAD)', async () => {
    const { bare, work } = setup();
    const linked = path.join(path.dirname(work), 'linked');
    git(work, 'worktree', 'add', '-b', 'feat', linked);
    writeFileSync(path.join(linked, 'b.txt'), 'b');
    git(linked, 'add', '.');
    git(linked, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feat');
    const sha = head(linked);
    expect(sha).not.toBe(head(work));
    await pushWithAppToken(linked, URL_OK, 'HEAD:refs/heads/feat', { getToken, runner: recordingRunner([], bare) });
    expect(head(bare, 'refs/heads/feat')).toBe(sha);
    await pushWithAppToken(linked, URL_OK, 'main', { getToken, runner: recordingRunner([], bare) });
    expect(head(bare, 'refs/heads/main')).toBe(head(work));
  });

  it('fails clearly when the ref does not exist, without running git', async () => {
    const { work } = setup();
    const runner = vi.fn(async () => '');
    const err = await pushWithAppToken(work, URL_OK, 'nope', { getToken, runner }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('invalid');
    expect(err.message).toContain('nope');
    expect(runner).not.toHaveBeenCalled();
  });

  describe('hostile or unsupported repositories', () => {
    const fail = async (work: string, spec = 'main') => {
      const runner = vi.fn(async () => '');
      const err = await pushWithAppToken(work, URL_OK, spec, { getToken, runner }).catch((e) => e);
      expect(runner).not.toHaveBeenCalled();
      return err;
    };

    it('rejects HEAD as a FIFO without hanging', async () => {
      const { work } = setup();
      rmSync(path.join(work, '.git', 'HEAD'));
      execFileSync('mkfifo', [path.join(work, '.git', 'HEAD')]);
      const err = await fail(work, 'HEAD:refs/heads/x');
      expect(err.kind).toBe('invalid');
    }, 4000);

    it('rejects a ref that is a symlink to /dev/zero without reading it', async () => {
      const { work } = setup();
      const ref = path.join(work, '.git', 'refs', 'heads', 'main');
      rmSync(ref);
      symlinkSync('/dev/zero', ref);
      const err = await fail(work);
      expect(err.kind).toBe('invalid');
    }, 4000);

    it('rejects an oversized ref file', async () => {
      const { work } = setup();
      writeFileSync(path.join(work, '.git', 'refs', 'heads', 'main'), 'a'.repeat(10_000));
      expect((await fail(work)).kind).toBe('invalid');
    });

    it('explains reftable repositories', async () => {
      const { work } = setup();
      appendFileSync(path.join(work, '.git', 'config'), '[extensions]\n\trefStorage = reftable\n');
      const err = await fail(work);
      expect(err.kind).toBe('invalid');
      expect(err.message).toMatch(/reftable/);
    });

    it('explains SHA-256 repositories', async () => {
      const { work } = setup();
      writeFileSync(path.join(work, '.git', 'refs', 'heads', 'main'), `${'ab'.repeat(32)}\n`);
      const err = await fail(work);
      expect(err.kind).toBe('invalid');
      expect(err.message).toMatch(/SHA-256/);
    });

    it.each(['refs/tags/v1', 'refs/remotes/origin/main', 'refs/tags/v1:refs/heads/x'])('rejects the source %s up front', async (spec) => {
      const { work } = setup();
      const err = await fail(work, spec);
      expect(err.kind).toBe('invalid');
    });
  });

  it('fails clearly when the project is not a git repository', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-nogit-'));
    const runner = vi.fn(async () => '');
    const err = await pushWithAppToken(dir, URL_OK, 'main', { getToken, runner }).catch((e) => e);
    expect(err.kind).toBe('invalid');
    expect(runner).not.toHaveBeenCalled();
  });

  it('scrubs the environment: tracing, inherited config, TLS overrides', async () => {
    const { work } = setup();
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_TRACE: '1',
      GIT_TRACE_CURL: '1',
      GIT_TRACE_PACKET: '1',
      GIT_TRACE_SETUP: '1',
      GIT_CURL_VERBOSE: '1',
      GIT_TRACE2: '1',
      GIT_TRACE2_EVENT: '1',
      GIT_CONFIG_PARAMETERS: "'a.b=c'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://evil',
      GIT_TRACE_REDACT: '0',
      GIT_SSL_NO_VERIFY: '1',
      GIT_SSL_CAINFO: '/evil.pem',
      GIT_SSL_CAPATH: '/evil',
      CURL_CA_BUNDLE: '/evil.pem',
      GIT_TRACE_PERFORMANCE: '1',
      GIT_TRACE_PACK_ACCESS: '1',
      HTTPS_PROXY: 'http://corp-proxy:3128',
      GIT_SSH_COMMAND: 'evil',
      GIT_ASKPASS: '/evil',
      SSH_ASKPASS: '/evil',
      GIT_PROXY_COMMAND: 'evil',
      GIT_EXEC_PATH: '/evil',
      GIT_NAMESPACE: 'ns',
      GIT_REPLACE_REF_BASE: 'refs/x/',
      GIT_SHALLOW_FILE: '/evil',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/evil',
      GIT_OBJECT_DIRECTORY: '/evil',
    });
    const calls: Rec[] = [];
    try {
      await pushWithAppToken(work, URL_OK, 'main', {
        getToken,
        runner: async (_f, a, o) => {
          calls.push({ args: a, cwd: o.cwd, env: o.env });
          return '';
        },
      });
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const env = calls[0].env;
    for (const k of ['GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_TRACE_PACKET', 'GIT_TRACE_SETUP', 'GIT_CURL_VERBOSE', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_CONFIG_PARAMETERS', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'CURL_CA_BUNDLE', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_PACK_ACCESS', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_OBJECT_DIRECTORY']) {
      expect(env[k]).toBeUndefined();
    }
    expect(envPairs(env)['http.proxy']).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://corp-proxy:3128');
    expect(env.GIT_CONFIG_COUNT).toBe('6');
    expect(env.GIT_TRACE_REDACT).toBe('1');
  });

  it.each([
    'origin',
    'http://github.com/me/app.git',
    'https://github.com.evil.com/me/app.git',
    'https://evil.com/me/app.git',
    'https://github.com/me/app/extra',
    'https://user@github.com/me/app.git',
    'https://github.com/me/app.git?x=1',
    'https://github.com/me/../app.git',
    'file:///tmp/x.git',
    '--upload-pack=evil',
    'https://github.com/me/ app.git',
  ])('rejects the push target %s before spawning', async (url) => {
    const runner = vi.fn();
    const err = await pushWithAppToken('/tmp', url, 'main', { getToken, runner }).catch((e) => e);
    expect(err.kind).toBe('invalid');
    expect(runner).not.toHaveBeenCalled();
  });

  it('accepts a URL without .git', async () => {
    const runner = vi.fn(async () => '');
    await pushWithAppToken(setup().work, 'https://github.com/me/app', 'main', { getToken, runner });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('scrubs the token and its base64 from a failure (runner stub)', async () => {
    const runner: GitRunner = async () => {
      throw Object.assign(new Error(`Command failed: git -c http.extraheader=AUTHORIZATION: basic ${BASIC} push`), {
        stderr: `fatal: header AUTHORIZATION: basic ${BASIC} rejected for tok_SECRET`,
      });
    };
    const err = await pushWithAppToken(setup().work, URL_OK, 'main', { getToken, runner }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const text = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(text).not.toContain('tok_SECRET');
    expect(text).not.toContain(BASIC);
    expect(err.message).toContain('***');
  });

  it('refuses without a token', async () => {
    const err = await pushWithAppToken(setup().work, URL_OK, 'main', { getToken: async () => null, runner: vi.fn() }).catch((e) => e);
    expect(err.kind).toBe('no-connection');
  });

  it('addOriginIfMissing adds once and keeps an existing origin', async () => {
    const { work } = setup();
    expect(await addOriginIfMissing(work, 'https://github.com/me/app.git')).toBe(true);
    expect(git(work, 'remote', 'get-url', 'origin').trim()).toBe('https://github.com/me/app.git');
    expect(await addOriginIfMissing(work, 'https://github.com/me/other.git')).toBe(false);
    expect(git(work, 'remote', 'get-url', 'origin').trim()).toBe('https://github.com/me/app.git');
  });
});
