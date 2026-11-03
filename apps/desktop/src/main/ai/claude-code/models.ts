/**
 * The models the configured endpoint offers, for the model pickers.
 *
 * Asks `GET {base}/v1/models` with the app's Claude credential:
 * - the Anthropic API answers `{ data: [{ id, display_name, created_at }], has_more, last_id }`
 *   (paginated with `after_id`);
 * - OpenAI-style endpoints (Ollama, LiteLLM and most gateways) answer `{ data: [{ id, created }] }`;
 * - Ollama without /v1 support falls back to its native `GET /api/tags`.
 *
 * Results are cached per endpoint for a few minutes. Never throws: a failure
 * comes back as `error`, and the pickers still accept a typed model id.
 */

import type { ClaudeModelInfo, ClaudeModelList } from '../../../shared/types/claude-credential';
import type { ClaudeAuth } from '../session/types';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 10;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const cache = new Map<string, ClaudeModelList>();

/** `https://host/v1/` → `https://host`; empty → the Anthropic API. */
export function normalizeEndpoint(baseURL: string | undefined): string {
  const trimmed = (baseURL ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return trimmed || ANTHROPIC_API_URL;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function authHeaders(auth: ClaudeAuth, bearer: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' };
  if (auth.oauthToken) {
    headers.authorization = `Bearer ${auth.oauthToken}`;
    headers['anthropic-beta'] = OAUTH_BETA;
  } else if (auth.apiKey) {
    if (bearer) headers.authorization = `Bearer ${auth.apiKey}`;
    else headers['x-api-key'] = auth.apiKey;
  }
  return headers;
}

/** The server's own error message, if the body has one. */
function errorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return undefined;
}

async function getJson(fetchFn: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new HttpError(response.status, errorDetail(body) ?? `HTTP ${response.status}`);
  }
  return body;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** One entry of `data` in either the Anthropic or the OpenAI shape. */
export function parseModelEntry(entry: unknown): ClaudeModelInfo | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const id = asString(record.id);
  if (!id) return null;
  const createdAt =
    asString(record.created_at) ??
    (typeof record.created === 'number' && record.created > 0 ? new Date(record.created * 1000).toISOString() : undefined);
  return { id, displayName: asString(record.display_name), createdAt };
}

interface Page {
  models: ClaudeModelInfo[];
  next?: string;
}

export function parseModelsPage(body: unknown): Page {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error('The endpoint did not return a model list');
  }
  const page = body as { data: unknown[]; has_more?: unknown; last_id?: unknown };
  const models = page.data.map(parseModelEntry).filter((m): m is ClaudeModelInfo => m !== null);
  const next = page.has_more === true ? asString(page.last_id) : undefined;
  return { models, next };
}

/** Ollama's native list: `{ models: [{ name, modified_at }] }`. */
export function parseOllamaTags(body: unknown): ClaudeModelInfo[] {
  const list = body && typeof body === 'object' ? (body as { models?: unknown }).models : undefined;
  if (!Array.isArray(list)) throw new Error('The endpoint did not return a model list');
  return list
    .map((entry): ClaudeModelInfo | null => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const id = asString(record.model) ?? asString(record.name);
      return id ? { id, createdAt: asString(record.modified_at) } : null;
    })
    .filter((m): m is ClaudeModelInfo => m !== null);
}

async function fetchV1Models(fetchFn: FetchLike, endpoint: string, auth: ClaudeAuth, bearer: boolean): Promise<ClaudeModelInfo[]> {
  const headers = authHeaders(auth, bearer);
  const models: ClaudeModelInfo[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: '1000' });
    if (after) query.set('after_id', after);
    const result = parseModelsPage(await getJson(fetchFn, `${endpoint}/v1/models?${query}`, headers));
    models.push(...result.models);
    if (!result.next || result.next === after) break;
    after = result.next;
  }
  return models;
}

function dedupe(models: ClaudeModelInfo[]): ClaudeModelInfo[] {
  const seen = new Set<string>();
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

async function load(fetchFn: FetchLike, endpoint: string, auth: ClaudeAuth, custom: boolean): Promise<ClaudeModelInfo[]> {
  try {
    return await fetchV1Models(fetchFn, endpoint, auth, false);
  } catch (error) {
    if (!custom) throw error;
    // Gateways that want `Authorization: Bearer` instead of `x-api-key`
    if (error instanceof HttpError && (error.status === 401 || error.status === 403) && auth.apiKey) {
      return fetchV1Models(fetchFn, endpoint, auth, true);
    }
    // Ollama builds without the /v1 API
    try {
      return parseOllamaTags(await getJson(fetchFn, `${endpoint}/api/tags`, authHeaders(auth, false)));
    } catch {
      throw error;
    }
  }
}

function describe(error: unknown, endpoint: string): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return `The endpoint rejected the key (${error.message})`;
    if (error.status === 404) return `${endpoint} has no model list (/v1/models)`;
    return error.message;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${endpoint} did not answer`;
  }
  if (error instanceof TypeError) return `Can't reach ${endpoint}`;
  return error instanceof Error ? error.message : String(error);
}

export interface ListModelsOptions {
  auth: ClaudeAuth;
  /** Skip the cache */
  refresh?: boolean;
  fetchFn?: FetchLike;
  now?: () => number;
}

export async function listEndpointModels(options: ListModelsOptions): Promise<ClaudeModelList> {
  const { auth, fetchFn = fetch, now = Date.now } = options;
  const endpoint = normalizeEndpoint(auth.oauthToken ? undefined : auth.baseURL);
  const custom = endpoint !== ANTHROPIC_API_URL;
  const credentialTag = (auth.oauthToken ?? auth.apiKey ?? '').slice(-6);
  const cacheKey = `${endpoint}|${credentialTag}`;

  const hit = cache.get(cacheKey);
  if (!options.refresh && hit && !hit.error && now() - hit.fetchedAt < CACHE_TTL_MS) return hit;

  if (!custom && !auth.apiKey && !auth.oauthToken) {
    return { models: [], endpoint, custom, error: 'Add a Claude API key first', fetchedAt: now() };
  }

  let result: ClaudeModelList;
  try {
    const models = dedupe(await load(fetchFn, endpoint, auth, custom));
    result = { models, endpoint, custom, fetchedAt: now() };
  } catch (error) {
    result = { models: [], endpoint, custom, error: describe(error, endpoint), fetchedAt: now() };
  }
  cache.set(cacheKey, result);
  return result;
}

/** Test hook */
export function clearModelListCache(): void {
  cache.clear();
}
