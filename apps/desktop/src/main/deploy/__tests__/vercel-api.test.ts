import { describe, it, expect } from 'vitest';
import { createVercelClient, defaultVercelFetcher, isVercelError, type VercelFetcher } from '../vercel-api';
import type { VercelError } from '../../../shared/types/deploy';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function fake(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const fetcher: VercelFetcher = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
    };
  };
  return { fetcher, calls };
}

const tok = (t: string | null = 'TOKEN-SECRET') => async () => t;
async function err(p: Promise<unknown>): Promise<VercelError> {
  try { await p; } catch (e) { return e as VercelError; }
  throw new Error('expected rejection');
}

describe('vercel-api', () => {
  it('createProject posts gitRepository and appends teamId', async () => {
    const { fetcher, calls } = fake([{ status: 200, body: { id: 'prj_1', name: 'app' } }]);
    const c = createVercelClient(fetcher, { teamId: 'team_1' }, tok());
    const r = await c.createProject({ name: 'app', repo: 'me/app', framework: 'nextjs', rootDirectory: 'web' });
    expect(r).toEqual({ id: 'prj_1', name: 'app' });
    expect(calls[0].url).toBe('https://api.vercel.com/v11/projects?teamId=team_1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe('Bearer TOKEN-SECRET');
    expect(JSON.parse(calls[0].body!)).toEqual({
      name: 'app', gitRepository: { type: 'github', repo: 'me/app' }, framework: 'nextjs', rootDirectory: 'web',
    });
  });

  it('createProject omits framework/rootDirectory when null', async () => {
    const { fetcher, calls } = fake([{ status: 200, body: { id: 'p', name: 'a' } }]);
    await createVercelClient(fetcher, {}, tok()).createProject({ name: 'a', repo: 'o/a', framework: null, rootDirectory: null });
    expect(calls[0].url).toBe('https://api.vercel.com/v11/projects');
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'a', gitRepository: { type: 'github', repo: 'o/a' } });
  });

  it('existing name -> conflict', async () => {
    const { fetcher } = fake([{ status: 409, body: { error: { code: 'conflict', message: 'The project name app already exists' } } }]);
    const e = await err(createVercelClient(fetcher, {}, tok()).createProject({ name: 'app', repo: 'o/app' }));
    expect(e.kind).toBe('conflict');
  });

  it('repo not reachable by the GitHub App -> git-not-connected with the payload link', async () => {
    const { fetcher } = fake([{ status: 400, body: { error: { code: 'bad_request', message: 'To link a GitHub repository, you need to install the GitHub integration first. (400)', link: 'https://github.com/apps/vercel/installations/new/permissions?target_id=1' } } }]);
    const e = await err(createVercelClient(fetcher, {}, tok()).createProject({ name: 'a', repo: 'o/a' }));
    expect(e.kind).toBe('git-not-connected');
    expect(e.actionUrl).toBe('https://github.com/apps/vercel/installations/new/permissions?target_id=1');
  });

  it('git-not-connected falls back to the install URL; also matched by code', async () => {
    const { fetcher } = fake([
      { status: 400, body: { error: { code: 'repo_not_found', message: 'nope' } } },
      { status: 400, body: { error: { code: 'bad_request', message: 'Failed to link o/a. Make sure the repository exists and the Vercel GitHub App has access to it.' } } },
    ]);
    const c = createVercelClient(fetcher, {}, tok());
    const e1 = await err(c.createProject({ name: 'a', repo: 'o/a' }));
    expect(e1).toMatchObject({ kind: 'git-not-connected', actionUrl: 'https://github.com/apps/vercel/installations/new' });
    const e2 = await err(c.createProject({ name: 'a', repo: 'o/a' }));
    expect(e2.kind).toBe('git-not-connected');
  });

  it('upsertEnv sends the value only in the body, with targets and type', async () => {
    const { fetcher, calls } = fake([{ status: 201, body: {} }, { status: 201, body: {} }]);
    const c = createVercelClient(fetcher, { teamId: 't' }, tok());
    await c.upsertEnv('prj_1', { key: 'API', value: 'S3CRET-VALUE', targets: ['production', 'preview'], sensitive: false });
    await c.upsertEnv('prj_1', { key: 'DB', value: 'S3CRET-2', targets: ['production'], sensitive: true });
    expect(calls[0].url).toBe('https://api.vercel.com/v10/projects/prj_1/env?upsert=true&teamId=t');
    expect(calls[0].url).not.toContain('S3CRET');
    expect(JSON.parse(calls[0].body!)).toEqual({ key: 'API', value: 'S3CRET-VALUE', target: ['production', 'preview'], type: 'encrypted' });
    expect(JSON.parse(calls[1].body!).type).toBe('sensitive');
  });

  it('upsertEnv errors never contain the value or the token', async () => {
    const { fetcher } = fake([{ status: 400, body: { error: { code: 'bad_request', message: 'Invalid value S3CRET-VALUE for TOKEN-SECRET' } } }]);
    const e = await err(createVercelClient(fetcher, {}, tok()).upsertEnv('p', { key: 'K', value: 'S3CRET-VALUE', targets: ['production'], sensitive: false }));
    expect(JSON.stringify(e)).not.toContain('S3CRET-VALUE');
    expect(JSON.stringify(e)).not.toContain('TOKEN-SECRET');
  });

  it('listEnvNames returns names and targets only, never values', async () => {
    const { fetcher } = fake([{ status: 200, body: { envs: [
      { key: 'A', value: 'leak1', decrypted: true, target: ['production', 'preview'], type: 'encrypted' },
      { key: 'B', value: 'leak2', target: 'development', type: 'plain' },
    ] } }]);
    const r = await createVercelClient(fetcher, {}, tok()).listEnvNames('prj_1');
    expect(r).toEqual([{ key: 'A', targets: ['production', 'preview'] }, { key: 'B', targets: ['development'] }]);
    expect(JSON.stringify(r)).not.toContain('leak');
  });

  it('findProject: null on 404, link repo as owner/name', async () => {
    const { fetcher, calls } = fake([
      { status: 404, body: { error: { code: 'not_found', message: 'x' } } },
      { status: 200, body: { id: 'p', name: 'app', link: { type: 'github', org: 'me', repo: 'app' } } },
      { status: 200, body: { id: 'p2', name: 'bare' } },
    ]);
    const c = createVercelClient(fetcher, { teamId: 't' }, tok());
    expect(await c.findProject('nope')).toBeNull();
    expect(calls[0].url).toBe('https://api.vercel.com/v9/projects/nope?teamId=t');
    expect(await c.findProject('app')).toEqual({ id: 'p', name: 'app', link: { repo: 'me/app' } });
    expect(await c.findProject('bare')).toEqual({ id: 'p2', name: 'bare' });
  });

  it('latestProductionUrl returns https url or null', async () => {
    const { fetcher, calls } = fake([
      { status: 200, body: { deployments: [{ url: 'app-abc.vercel.app' }] } },
      { status: 200, body: { deployments: [] } },
    ]);
    const c = createVercelClient(fetcher, {}, tok());
    expect(await c.latestProductionUrl('prj')).toBe('https://app-abc.vercel.app');
    expect(calls[0].url).toContain('/v6/deployments?');
    expect(calls[0].url).toContain('projectId=prj');
    expect(calls[0].url).toContain('target=production');
    expect(calls[0].url).toContain('state=READY');
    expect(await c.latestProductionUrl('prj')).toBeNull();
  });

  it('401 -> no-connection after one retry with a fresh token', async () => {
    const { fetcher, calls } = fake([{ status: 401 }, { status: 401 }]);
    const tokens = ['old', 'new'];
    const e = await err(createVercelClient(fetcher, {}, async () => tokens.shift() ?? null).listEnvNames('p'));
    expect(e.kind).toBe('no-connection');
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.Authorization).toBe('Bearer new');
  });

  it('401 then success retries once and succeeds', async () => {
    const { fetcher, calls } = fake([{ status: 401 }, { status: 200, body: { envs: [] } }]);
    const tokens = ['old', 'new'];
    expect(await createVercelClient(fetcher, {}, async () => tokens.shift() ?? null).listEnvNames('p')).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('no token -> no-connection without a request', async () => {
    const { fetcher, calls } = fake([]);
    const e = await err(createVercelClient(fetcher, {}, tok(null)).listEnvNames('p'));
    expect(e.kind).toBe('no-connection');
    expect(calls).toHaveLength(0);
  });

  it('429 -> rate-limit with resetAt; 403, 404, 5xx, network mapping', async () => {
    const { fetcher } = fake([
      { status: 429, headers: { 'x-ratelimit-reset': '1800000000' } },
      { status: 403, body: { error: { code: 'forbidden', message: 'no' } } },
      { status: 404, body: { error: { code: 'not_found', message: 'gone' } } },
      { status: 503 },
      new Error('ECONNRESET'),
    ]);
    const c = createVercelClient(fetcher, {}, tok());
    const e1 = await err(c.listEnvNames('p'));
    expect(e1).toMatchObject({ kind: 'rate-limit', resetAt: new Date(1800000000 * 1000).toISOString() });
    expect((await err(c.listEnvNames('p'))).kind).toBe('forbidden');
    expect((await err(c.listEnvNames('p'))).kind).toBe('not-found');
    expect((await err(c.listEnvNames('p'))).kind).toBe('unavailable');
    expect((await err(c.listEnvNames('p'))).kind).toBe('unavailable');
  });

  it('git-not-connected is scoped to createProject', async () => {
    const { fetcher } = fake([
      { status: 400, body: { error: { code: 'bad_request', message: 'Invalid key. The Vercel GitHub App has access issues' } } },
      { status: 400, body: { error: { code: 'bad_request', message: 'Project names can be up to 100 characters' } } },
      { status: 409, body: { error: { code: 'conflict', message: 'Name taken; install the GitHub App to link' } } },
    ]);
    const c = createVercelClient(fetcher, {}, tok());
    const e1 = await err(c.upsertEnv('p', { key: 'bad key', value: 'v', targets: ['production'], sensitive: false }));
    expect(e1.kind).toBe('bad-request');
    const e2 = await err(c.createProject({ name: 'A B', repo: 'o/a' }));
    expect(e2.kind).toBe('bad-request');
    const e3 = await err(c.createProject({ name: 'a', repo: 'o/a' }));
    expect(e3.kind).toBe('conflict');
  });

  it('other 4xx are bad-request with the redacted message, never retried', async () => {
    const { fetcher, calls } = fake([
      { status: 422, body: { error: { code: 'x', message: 'bad TOKEN-SECRET' } } },
      { status: 402, body: { error: { code: 'payment_required', message: 'Upgrade' } } },
    ]);
    const c = createVercelClient(fetcher, {}, tok());
    const e = await err(c.listEnvNames('p'));
    expect(e).toMatchObject({ kind: 'bad-request', message: 'bad ***' });
    expect((await err(c.listEnvNames('p'))).kind).toBe('bad-request');
    expect(calls).toHaveLength(2);
  });

  it('actionUrl only from github.com or vercel.com over https', async () => {
    const mk = (link: string) => fake([{ status: 400, body: { error: { code: 'repo_not_found', message: 'm', link } } }]).fetcher;
    const fb = 'https://github.com/apps/vercel/installations/new';
    for (const [link, want] of [
      ['https://vercel.com/x', 'https://vercel.com/x'],
      ['http://github.com/x', fb],
      ['https://evil.com/x', fb],
      ['https://github.com.evil.com/x', fb],
      ['javascript:alert(1)', fb],
    ]) {
      const e = await err(createVercelClient(mk(link), {}, tok()).createProject({ name: 'a', repo: 'o/a' }));
      expect(e.actionUrl).toBe(want);
    }
  });

  it('default fetcher times out -> unavailable path (abort signal passed)', async () => {
    const orig = globalThis.fetch;
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_u: string, init: RequestInit) => { signal = init.signal as AbortSignal; throw new DOMException('t', 'TimeoutError'); }) as unknown as typeof fetch;
    try {
      const e = await err(createVercelClient(defaultVercelFetcher, {}, tok()).listEnvNames('p'));
      expect(e.kind).toBe('unavailable');
      expect(signal).toBeDefined();
    } finally { globalThis.fetch = orig; }
  });

  it('createProject without an id in a 2xx body fails; link only for github', async () => {
    const { fetcher } = fake([
      { status: 200, body: { name: 'a' } },
      { status: 200, body: { id: 'p', name: 'a', link: { type: 'gitlab', org: 'o', repo: 'a' } } },
    ]);
    const c = createVercelClient(fetcher, {}, tok());
    expect((await err(c.createProject({ name: 'a', repo: 'o/a' }))).kind).toBe('unavailable');
    expect(await c.findProject('a')).toEqual({ id: 'p', name: 'a' });
  });

  it('short values are not redacted; isVercelError narrows', async () => {
    const { fetcher } = fake([{ status: 400, body: { error: { code: 'x', message: 'bad a value' } } }]);
    const e = await err(createVercelClient(fetcher, {}, tok()).upsertEnv('p', { key: 'K', value: 'a', targets: ['production'], sensitive: false }));
    expect(e.message).toBe('bad a value');
    expect(isVercelError(e)).toBe(true);
    expect(isVercelError(new Error('x'))).toBe(false);
    expect(isVercelError(null)).toBe(false);
  });
});
