import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../github-auth/token-store', () => ({ getValidAccessToken: vi.fn() }));

import { githubFetcher } from '../github-fetcher';
import { getValidAccessToken } from '../../github-auth/token-store';

describe('githubFetcher', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockResolvedValue('tok');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('no token is no-connection', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(null);
    await expect(githubFetcher('/x')).rejects.toMatchObject({ kind: 'no-connection' });
  });
  it('token store throwing is no-connection', async () => {
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error('x'));
    await expect(githubFetcher('/x')).rejects.toMatchObject({ kind: 'no-connection' });
  });
  it('network error is unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;
    await expect(githubFetcher('/x')).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('returns status, headers and parsed body', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    globalThis.fetch = f as never;
    const res = await githubFetcher('/repos/a/b');
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ a: 1 });
  });

  it('sends If-None-Match and serves the cached body on 304', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ a: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    globalThis.fetch = f as never;
    await githubFetcher('/repos/etag/test');
    const res = await githubFetcher('/repos/etag/test');
    expect((f.mock.calls[1][1] as { headers: Record<string, string> }).headers['If-None-Match']).toBe('"v1"');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ a: 1 });
  });
});
