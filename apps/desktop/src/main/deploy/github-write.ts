/**
 * GitHub write operations for the Deploy view: create a private repo, push with the
 * GitHub App user token, add the origin remote, set Actions secrets, read visibility.
 *
 * The token is only ever sent as an Authorization header (REST) or, for a push, as
 * scoped git config in the child's env (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n`, an `http.extraheader`), never in argv. It is never written to
 * a remote URL or a git config file, and never appears in errors or logs.
 */
import { execFile } from 'child_process';
import { chmod, lstat, mkdir, mkdtemp, open, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
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
  let response: Awaited<ReturnType<JsonFetch>>;
  try {
    response = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new GitHubWriteError('unavailable', 'Could not reach GitHub. Check your connection and try again.');
  }
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
    const candidate = attempt === 1 ? name.slice(0, 100) : `${name.slice(0, 98)}-${attempt}`;
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

/** Login of the user the App token acts for. */
export async function getAuthenticatedLogin(options: GitHubWriteOptions = {}): Promise<string> {
  const res = await api(options, 'GET', '/user');
  if (res.status < 200 || res.status >= 300) throw fromClassified(res.status, res.headers, res.body);
  if (!isObj(res.body) || typeof res.body.login !== 'string') {
    throw new GitHubWriteError('unavailable', 'GitHub returned an unexpected response for the signed-in user');
  }
  return res.body.login;
}

/** Visibility, creation time and whether the repo has no branches; null when it doesn't exist (or isn't visible). */
export async function inspectRepo(
  owner: string,
  repo: string,
  options: GitHubWriteOptions = {},
): Promise<{ private: boolean; createdAt: string; empty: boolean } | null> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await api(options, 'GET', base);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw fromClassified(res.status, res.headers, res.body);
  const body = isObj(res.body) ? res.body : {};
  const branches = await api(options, 'GET', `${base}/branches?per_page=1`);
  // Only a clear "no branches" counts as empty.
  const empty = branches.status === 200 && Array.isArray(branches.body) && branches.body.length === 0;
  return { private: body.private === true, createdAt: typeof body.created_at === 'string' ? body.created_at : '', empty };
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

/** Names of the repository's Actions secrets (GitHub never returns values). Up to 10 pages of 100. */
export async function listRepoSecretNames(owner: string, repo: string, options: GitHubWriteOptions = {}): Promise<string[]> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets`;
  const names: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await api(options, 'GET', `${base}?per_page=100${page > 1 ? `&page=${page}` : ''}`);
    if (res.status < 200 || res.status >= 300) throw fromClassified(res.status, res.headers, res.body);
    const list = isObj(res.body) && Array.isArray(res.body.secrets) ? res.body.secrets : [];
    for (const s of list) if (isObj(s) && typeof s.name === 'string') names.push(s.name);
    if (list.length < 100) break;
  }
  return names;
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

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;

/** Env variables that could print the token (tracing) or inject config; removed from the child. */
function isUnsafeGitVar(key: string): boolean {
  return (
    key === 'GIT_TRACE' ||
    key === 'GIT_TRACE_CURL' ||
    key === 'GIT_TRACE_PACKET' ||
    key === 'GIT_TRACE_SETUP' ||
    key === 'GIT_CURL_VERBOSE' ||
    key === 'GIT_TRACE_PERFORMANCE' ||
    key === 'GIT_TRACE_PACK_ACCESS' ||
    key === 'GIT_SSL_NO_VERIFY' ||
    key === 'GIT_SSL_CAINFO' ||
    key === 'GIT_SSL_CAPATH' ||
    key === 'CURL_CA_BUNDLE' ||
    key === 'GIT_SSH_COMMAND' ||
    key === 'GIT_ASKPASS' ||
    key === 'SSH_ASKPASS' ||
    key === 'GIT_PROXY_COMMAND' ||
    key === 'GIT_EXEC_PATH' ||
    key === 'GIT_NAMESPACE' ||
    key === 'GIT_REPLACE_REF_BASE' ||
    key === 'GIT_SHALLOW_FILE' ||
    key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
    key === 'GIT_OBJECT_DIRECTORY' ||
    key.startsWith('GIT_TRACE2') ||
    key === 'GIT_CONFIG_PARAMETERS' ||
    key === 'GIT_CONFIG_COUNT' ||
    /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
  );
}

function scrubbedGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(getIsolatedGitEnv())) if (!isUnsafeGitVar(k)) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/;
const SMALL_FILE = 4096;
const PACKED_REFS_MAX = 64 * 1024 * 1024;

const invalid = (message: string): GitHubWriteError => new GitHubWriteError('invalid', message);

/** A small regular file's text, read with a bound; null when missing. Anything else (FIFO, symlink, device, huge) is refused without being read. */
async function readText(file: string, max = SMALL_FILE): Promise<string | null> {
  let st;
  try {
    st = await lstat(file);
  } catch {
    return null;
  }
  if (st.isDirectory()) return null;
  if (!st.isFile()) throw invalid('The project has an unexpected git file and was not pushed');
  if (st.size > max) throw invalid('The project has an unexpectedly large git file and was not pushed');
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buf, 0, max + 1, 0);
    if (bytesRead > max) throw invalid('The project has an unexpectedly large git file and was not pushed');
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

/** The project's git dir (own HEAD) and common dir (refs, objects); for a linked worktree they differ. Reads files only. */
async function locateGitDirs(projectPath: string): Promise<{ gitDir: string; commonDir: string }> {
  const dotGit = path.join(projectPath, '.git');
  let st;
  try {
    st = await stat(dotGit);
  } catch {
    throw invalid('The project is not a git repository');
  }
  let gitDir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dotGit)) ?? '');
    if (!m) throw invalid('The project is not a git repository');
    gitDir = path.resolve(projectPath, m[1]);
  }
  const common = (await readText(path.join(gitDir, 'commondir')))?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const headText = (await readText(path.join(gitDir, 'HEAD'))) ?? (await readText(path.join(commonDir, 'HEAD')));
  if (headText === null) throw invalid('The project is not a git repository');
  const config = (await readText(path.join(commonDir, 'config'), 64 * 1024)) ?? '';
  if (/^\s*ref:\s*refs\/heads\/\.invalid\s*$/.test(headText) || /^\s*refstorage\s*=\s*reftable\b/im.test(config)) {
    throw invalid("This repository uses reftable refs, which Vibe Teamlead can't push yet");
  }
  return { gitDir, commonDir };
}

function checkSha(value: string): string | null {
  if (SHA256.test(value)) throw invalid("SHA-256 repositories aren't supported by GitHub");
  return SHA1.test(value) ? value : null;
}

async function readRef(gitDir: string, commonDir: string, ref: string, depth = 0): Promise<string | null> {
  if (depth > 5 || ref.includes('..') || ref.startsWith('/')) return null;
  const perWorktree = ref === 'HEAD' || ref.startsWith('refs/bisect/') || ref.startsWith('refs/worktree/');
  const loose = (await readText(path.join(perWorktree ? gitDir : commonDir, ref)))?.trim();
  if (loose) {
    const sym = /^ref:\s*(\S+)$/.exec(loose);
    if (sym) return readRef(gitDir, commonDir, sym[1], depth + 1);
    return checkSha(loose);
  }
  const packed = (await readText(path.join(commonDir, 'packed-refs'), PACKED_REFS_MAX)) ?? '';
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha, name] = line.trim().split(' ');
    if (name === ref) return checkSha(sha ?? '');
  }
  return null;
}

/** `src[:dst]` → the commit to push and its destination branch ref, resolved from files (no git process, no project config). */
async function resolvePushSource(
  projectPath: string,
  refspec: string,
): Promise<{ sha: string; dst: string; commonDir: string }> {
  if (refspec.startsWith('-') || refspec.startsWith('+')) throw invalid('Invalid refspec');
  const [src, dstRaw, ...extra] = refspec.split(':');
  if (extra.length || !src || !BRANCH_NAME.test(src) || (dstRaw !== undefined && !BRANCH_NAME.test(dstRaw))) {
    throw invalid('Invalid refspec');
  }
  if (src !== 'HEAD' && src.startsWith('refs/') && !src.startsWith('refs/heads/')) {
    throw invalid('Only branches can be pushed');
  }
  const { gitDir, commonDir } = await locateGitDirs(projectPath);
  const candidates = src === 'HEAD' || src.startsWith('refs/') ? [src] : [`refs/heads/${src}`];
  let sha: string | null = null;
  for (const c of candidates) {
    sha = await readRef(gitDir, commonDir, c);
    if (sha) break;
  }
  if (!sha) throw invalid(`Branch "${src}" was not found in the project`);
  let dst = dstRaw;
  if (!dst) {
    dst = src.startsWith('refs/heads/') ? src : src === 'HEAD' ? '' : `refs/heads/${src}`;
    if (!dst) throw invalid('Give a destination branch when pushing HEAD');
  } else if (!dst.startsWith('refs/')) {
    dst = `refs/heads/${dst}`;
  }
  if (!dst.startsWith('refs/heads/') || dst.includes('..') || dst.endsWith('/') || dst.endsWith('.lock')) {
    throw invalid('Invalid destination branch');
  }
  return { sha, dst, commonDir };
}

/** The kind of a failed push, from git's stderr. */
export function classifyPushFailure(stderr: string): GitHubWriteError['kind'] {
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(stderr)) return 'conflict';
  if (/\berror: 403\b|not accessible by integration|Permission to \S+ denied/i.test(stderr)) return 'permissions';
  if (/\berror: 401\b|Authentication failed|could not read Username/i.test(stderr)) return 'no-connection';
  return 'unavailable';
}

/**
 * Pushes `refspec` (`branch[:dst]`, or `HEAD:dst`) to the GitHub repo at `url`
 * (exactly https://github.com/<owner>/<repo>[.git]) authenticating with the App user token.
 *
 * The project's git config, hooks and worktree config are never loaded: the commit is
 * resolved by reading ref files, then pushed from a private temporary bare repo that
 * borrows the project's objects through `objects/info/alternates`. The token travels in
 * the child's env as scoped git config (not argv); redirects are refused.
 */
export async function pushWithAppToken(
  projectPath: string,
  url: string,
  refspec: string,
  options: PushOptions = {},
): Promise<void> {
  const { getToken = getValidAccessToken, runner = defaultRunner } = options;
  const m = GITHUB_URL.exec(url);
  if (!m || m[2] === '.' || m[2] === '..') {
    throw invalid('Push target must be https://github.com/<owner>/<repo>');
  }
  const { sha, dst, commonDir } = await resolvePushSource(projectPath, refspec);
  const token = await getToken();
  if (!token) throw new GitHubWriteError('no-connection', 'Not signed in to GitHub. Please sign in first.');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const root = await mkdtemp(path.join(tmpdir(), 'vt-push-'));
  try {
    await chmod(root, 0o700);
    const gitDir = path.join(root, 'repo.git');
    const hooksDir = path.join(root, 'hooks');
    await mkdir(hooksDir, { mode: 0o700 });
    const env = scrubbedGitEnv();
    await defaultRunner(getToolPath('git'), ['init', '--bare', '--quiet', '--template=', gitDir], {
      cwd: root,
      env,
      timeout: 10_000,
    });
    await mkdir(path.join(gitDir, 'objects', 'info'), { recursive: true });
    await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(commonDir, 'objects')}\n`);
    const config: Array<[string, string]> = [
      ['credential.helper', ''],
      ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`],
      ['http.followRedirects', 'false'],
      ['http.sslVerify', 'true'],
      ['core.hooksPath', hooksDir],
      ['push.gpgSign', 'false'],
    ];
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
    env.GIT_TRACE_REDACT = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    await runner(getToolPath('git'), [`--git-dir=${gitDir}`, 'push', '--no-verify', '--', url, `${sha}:${dst}`], {
      cwd: root,
      env,
      timeout: PUSH_TIMEOUT_MS,
    });
  } catch (error) {
    const raw = String((error as { stderr?: unknown }).stderr ?? '').trim() || 'git push failed';
    const clean = raw.split(token).join('***').split(basic).join('***').slice(0, 500);
    throw new GitHubWriteError(classifyPushFailure(raw), `git push failed: ${clean}`);
  } finally {
    await rm(root, { recursive: true, force: true });
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
