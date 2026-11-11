import { describe, it, expect, vi } from 'vitest';
import { execFileSync, execFile } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sodium from 'libsodium-wrappers';
import {
  createPrivateRepo,
  pushWithAppToken,
  addOriginIfMissing,
  setRepoSecret,
  repoVisibility,
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

describe('repoVisibility', () => {
  it('maps private flag', async () => {
    const a = fakeFetch(() => ({ status: 200, body: { private: true } }));
    expect(await repoVisibility('me', 'app', { fetchImpl: a.impl, getToken })).toBe('private');
    expect(a.calls[0].url).toBe('https://api.github.com/repos/me/app');
    const b = fakeFetch(() => ({ status: 200, body: { private: false } }));
    expect(await repoVisibility('me', 'app', { fetchImpl: b.impl, getToken })).toBe('public');
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
    return { bare, work };
  }
  function recordingRunner(calls: { args: string[]; env: Record<string, string | undefined> }[]): GitRunner {
    return (file, args, opts) =>
      new Promise((resolve, reject) => {
        calls.push({ args, env: opts.env });
        execFile('git', args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv }, (e, stdout, stderr) =>
          e ? reject(Object.assign(e, { stderr })) : resolve(String(stdout)),
        );
        void file;
      });
  }

  it('passes the extraheader only as -c of that command and leaves config untouched', async () => {
    const { bare, work } = setup();
    const before = readFileSync(path.join(work, '.git', 'config'), 'utf-8');
    const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
    await pushWithAppToken(work, bare, 'main:refs/heads/main', { getToken, runner: recordingRunner(calls) });
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(git(work, 'rev-parse', 'HEAD').trim());
    expect(calls).toHaveLength(1);
    const expected = `http.extraheader=AUTHORIZATION: basic ${Buffer.from('x-access-token:tok_SECRET').toString('base64')}`;
    const { args, env } = calls[0];
    expect(args[0]).toBe('-c');
    expect(args).toContain(expected);
    expect(args.indexOf(expected)).toBe(args.indexOf('-c') + 1 + args.slice(args.indexOf('-c') + 1).indexOf(expected));
    expect(args.slice(-3)).toEqual(['push', bare, 'main:refs/heads/main']);
    expect(readFileSync(path.join(work, '.git', 'config'), 'utf-8')).toBe(before);
    expect(readFileSync(path.join(bare, 'config'), 'utf-8')).not.toContain('tok_SECRET');
    expect(Object.values(env).join('\n')).not.toContain('tok_SECRET');
    expect(Object.values(env).join('\n')).not.toContain(Buffer.from('x-access-token:tok_SECRET').toString('base64'));
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('redacts the token from failures', async () => {
    const { work } = setup();
    const err = await pushWithAppToken(work, '/nonexistent/remote.git', 'main', {
      getToken,
      runner: recordingRunner([]),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const text = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(text).not.toContain('tok_SECRET');
    expect(text).not.toContain(Buffer.from('x-access-token:tok_SECRET').toString('base64'));
    expect(text).not.toContain('extraheader');
  });

  it('refuses without a token', async () => {
    const { work, bare } = setup();
    const err = await pushWithAppToken(work, bare, 'main', { getToken: async () => null, runner: recordingRunner([]) }).catch((e) => e);
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
