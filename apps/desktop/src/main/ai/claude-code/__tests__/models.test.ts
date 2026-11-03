import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearModelListCache, listEndpointModels, normalizeEndpoint, parseModelEntry, parseOllamaTags } from '../models';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('normalizeEndpoint', () => {
  it('defaults to the Anthropic API and strips /v1 and slashes', () => {
    expect(normalizeEndpoint(undefined)).toBe('https://api.anthropic.com');
    expect(normalizeEndpoint('  ')).toBe('https://api.anthropic.com');
    expect(normalizeEndpoint('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(normalizeEndpoint('https://gw.example.com/anthropic/')).toBe('https://gw.example.com/anthropic');
  });
});

describe('parsers', () => {
  it('reads Anthropic and OpenAI-style entries', () => {
    expect(parseModelEntry({ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-05-01T00:00:00Z' })).toEqual({
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      createdAt: '2026-05-01T00:00:00Z',
    });
    expect(parseModelEntry({ id: 'qwen3-coder:30b', created: 1_700_000_000 })?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parseModelEntry({ name: 'no-id' })).toBeNull();
  });

  it('reads Ollama tags', () => {
    expect(parseOllamaTags({ models: [{ name: 'llama3:8b', model: 'llama3:8b' }, {}] })).toEqual([{ id: 'llama3:8b', createdAt: undefined }]);
    expect(() => parseOllamaTags({})).toThrow();
  });
});

describe('listEndpointModels', () => {
  beforeEach(() => clearModelListCache());

  it('pages through the Anthropic list with x-api-key', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(200, { data: [{ id: 'claude-opus-5-5' }], has_more: true, last_id: 'claude-opus-5-5' }))
      .mockResolvedValueOnce(json(200, { data: [{ id: 'claude-haiku-5-5' }], has_more: false }));
    const list = await listEndpointModels({ auth: { apiKey: 'sk-ant-api-1' }, fetchFn });

    expect(list.error).toBeUndefined();
    expect(list.custom).toBe(false);
    expect(list.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(init.headers['x-api-key']).toBe('sk-ant-api-1');
    expect(init.headers.authorization).toBeUndefined();
    expect(fetchFn.mock.calls[1][0]).toContain('after_id=claude-opus-5-5');
  });

  it('caches per endpoint and refreshes on request', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => json(200, { data: [{ id: 'm' }] }));
    const auth = { apiKey: 'k', baseURL: 'http://localhost:11434' };
    await listEndpointModels({ auth, fetchFn });
    await listEndpointModels({ auth, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await listEndpointModels({ auth, fetchFn, refresh: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries a custom endpoint with a bearer token after 401', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { message: 'bad key' } }))
      .mockResolvedValueOnce(json(200, { object: 'list', data: [{ id: 'gpt-oss:20b', created: 1 }] }));
    const list = await listEndpointModels({ auth: { apiKey: 'k', baseURL: 'https://gw.example.com' }, fetchFn });
    expect(list.models.map((m) => m.id)).toEqual(['gpt-oss:20b']);
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer k');
  });

  it('falls back to Ollama /api/tags', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(404, {}))
      .mockResolvedValueOnce(json(200, { models: [{ name: 'qwen3-coder:30b' }] }));
    const list = await listEndpointModels({ auth: { apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' }, fetchFn });
    expect(list.custom).toBe(true);
    expect(list.endpoint).toBe('http://localhost:11434');
    expect(fetchFn.mock.calls[1][0]).toBe('http://localhost:11434/api/tags');
    expect(list.models).toEqual([{ id: 'qwen3-coder:30b', createdAt: undefined }]);
  });

  it('reports failures instead of throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const list = await listEndpointModels({ auth: { apiKey: 'k', baseURL: 'http://localhost:1' }, fetchFn });
    expect(list.models).toEqual([]);
    expect(list.error).toBe("Can't reach http://localhost:1");

    const rejected = await listEndpointModels({ auth: { apiKey: 'bad' }, fetchFn: vi.fn().mockResolvedValue(json(401, { error: { message: 'invalid x-api-key' } })) });
    expect(rejected.error).toBe('The endpoint rejected the key (invalid x-api-key)');
  });

  it('asks for a key before calling the Anthropic API', async () => {
    const fetchFn = vi.fn();
    const list = await listEndpointModels({ auth: {}, fetchFn });
    expect(list.error).toBe('Add a Claude API key first');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the OAuth beta header for a subscription token and ignores the base URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(200, { data: [] }));
    await listEndpointModels({ auth: { oauthToken: 'sk-ant-oat-1', baseURL: 'http://x' }, fetchFn });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url.startsWith('https://api.anthropic.com/')).toBe(true);
    expect(init.headers.authorization).toBe('Bearer sk-ant-oat-1');
    expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});
