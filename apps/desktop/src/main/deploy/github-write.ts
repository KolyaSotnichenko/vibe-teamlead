/**
 * GitHub write operations for the Deploy view: create a private repo, push with the
 * GitHub App user token, add the origin remote, set Actions secrets, read visibility.
 *
 * The token is only ever sent as an Authorization header (REST) or as a one-shot
 * `-c http.extraheader=…` argument of a single git command. It is never written to
 * a remote URL or git config, and never appears in errors or logs.
 */
import { execFile } from 'child_process';
import sodium from 'libsodium-wrappers';
import type { GitHubError } from '../../shared/types/deploy';
import { getValidAccessToken } from '../github-auth/token-store';
import { getToolPath } from '../cli-tool-manager';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { classifyGitHubError } from './github-actions';

const GITHUB_API = 'https://api.github.com';
const MAX_NAME_TRIES = 5;
const PUSH_TIMEOUT_MS = 120_000;
const APPROVE_HINT = 'Approve the new permissions for the Vibe Teamlead GitHub App in GitHub, then try again.';

type JsonFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'headers'>>;

export interface GitHubWriteOptions {
  fetchImpl?: JsonFetch;
  getToken?: () => Promise<string | null>;
}

export type GitRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; timeout: number },
) => Promise<string>;

export interface PushOptions {
  getToken?: () => Promise<string | null>;
  runner?: GitRunner;
}

/** Error carrying a classified GitHub error kind. */
export class GitHubWriteError extends Error {
  readonly kind: GitHubError['kind'] | 'conflict' | 'invalid';
  readonly status?: number;
  constructor(kind: GitHubWriteError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'GitHubWriteError';
    this.kind = kind;
    this.status = status;
  }
}

function fromClassified(status: number, headers: Headers, body: unknown): GitHubWriteError {
  const c = classifyGitHubError(status, headers, body);
  const message = c.kind === 'permissions' ? `${c.message}. ${APPROVE_HINT}` : c.message;
  return new GitHubWriteError(c.kind, message, status);
}

async function api(
  opts: GitHubWriteOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const { fetchImpl = fetch as JsonFetch, getToken = getValidAccessToken } = opts;
  const token = await getToken();
  if (!token) throw new GitHubWriteError('no-connection', 'Not signed in to GitHub. Please sign in first.');
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function nameExists(body: unknown): boolean {
  if (!isObj(body) || !Array.isArray(body.errors)) return false;
  return body.errors.some((e) => isObj(e) && typeof e.message === 'string' && /name already exists/i.test(e.message));
}

export async function createPrivateRepo(
  name: string,
  options: GitHubWriteOptions = {},
): Promise<{ owner: string; repo: string; cloneUrl: string }> {
  for (let attempt = 1; attempt <= MAX_NAME_TRIES; attempt++) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    const res = await api(options, 'POST', '/user/repos', { name: candidate, private: true, auto_init: false });
    if (res.status >= 200 && res.status < 300 && isObj(res.body)) {
      const owner = isObj(res.body.owner) ? res.body.owner.login : undefined;
      const repo = res.body.name;
      const cloneUrl = res.body.clone_url;
      if (typeof owner === 'string' && typeof repo === 'string' && typeof cloneUrl === 'string') {
        return { owner, repo, cloneUrl };
      }
      throw new GitHubWriteError('unavailable', 'GitHub returned an unexpected response when creating the repository');
    }
    if (res.status === 422 && nameExists(res.body)) continue;
    throw fromClassified(res.status, res.headers, res.body);
  }
  throw new GitHubWriteError('conflict', `A repository named "${name}" already exists (tried ${MAX_NAME_TRIES} names)`, 422);
}

export async function repoVisibility(
  owner: string,
  repo: string,
  options: GitHubWriteOptions = {},
): Promise<'private' | 'public'> {
  const res = await api(options, 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (res.status < 200 || res.status >= 300) throw fromClassified(res.status, res.headers, res.body);
  return isObj(res.body) && res.body.private === true ? 'private' : 'public';
}

export function isValidSecretName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && !name.startsWith('GITHUB_');
}

export async function setRepoSecret(
  owner: string,
  repo: string,
  name: string,
  value: string,
  options: GitHubWriteOptions = {},
): Promise<void> {
  if (!isValidSecretName(name)) {
    throw new GitHubWriteError('invalid', `Invalid secret name "${name}"`);
  }
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets`;
  const keyRes = await api(options, 'GET', `${base}/public-key`);
  if (keyRes.status < 200 || keyRes.status >= 300) throw fromClassified(keyRes.status, keyRes.headers, keyRes.body);
  const keyBody = keyRes.body;
  if (!isObj(keyBody) || typeof keyBody.key !== 'string' || typeof keyBody.key_id !== 'string') {
    throw new GitHubWriteError('unavailable', 'GitHub returned an unexpected repository public key');
  }
  await sodium.ready;
  const publicKey = sodium.from_base64(keyBody.key, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
  const encrypted = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  const put = await api(options, 'PUT', `${base}/${name}`, { encrypted_value: encrypted, key_id: keyBody.key_id });
  if (put.status < 200 || put.status >= 300) throw fromClassified(put.status, put.headers, put.body);
}

const defaultRunner: GitRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, timeout: opts.timeout, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') }));
        else resolve(String(stdout));
      },
    );
  });

/** Pushes `refspec` to `remote` authenticating with the App user token for this one command only. */
export async function pushWithAppToken(
  projectPath: string,
  remote: string,
  refspec: string,
  options: PushOptions = {},
): Promise<void> {
  const { getToken = getValidAccessToken, runner = defaultRunner } = options;
  const token = await getToken();
  if (!token) throw new GitHubWriteError('no-connection', 'Not signed in to GitHub. Please sign in first.');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const args = [
    '-c',
    'credential.helper=',
    '-c',
    `http.extraheader=AUTHORIZATION: basic ${basic}`,
    'push',
    remote,
    refspec,
  ];
  const env = { ...getIsolatedGitEnv(), GIT_TERMINAL_PROMPT: '0' };
  try {
    await runner(getToolPath('git'), args, { cwd: projectPath, env, timeout: PUSH_TIMEOUT_MS });
  } catch (error) {
    // The command line carries the token: report git's own message, scrubbed, never the command.
    const raw = String((error as { stderr?: unknown }).stderr ?? '').trim() || 'git push failed';
    const clean = raw.split(token).join('***').split(basic).join('***').slice(0, 500);
    throw new GitHubWriteError('unavailable', `git push failed: ${clean}`);
  }
}

function gitOut(args: string[], cwd: string): Promise<string> {
  return defaultRunner(getToolPath('git'), args, { cwd, env: getIsolatedGitEnv(), timeout: 10_000 });
}

/** Adds `origin` pointing at `cloneUrl` unless the project already has one. True when added. */
export async function addOriginIfMissing(projectPath: string, cloneUrl: string): Promise<boolean> {
  const remotes = (await gitOut(['remote'], projectPath)).split('\n').map((s) => s.trim());
  if (remotes.includes('origin')) return false;
  await gitOut(['remote', 'add', 'origin', cloneUrl], projectPath);
  return true;
}
