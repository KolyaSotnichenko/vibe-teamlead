/**
 * GitHub sign-in and repository handlers.
 *
 * Sign-in uses the Vibe Teamlead GitHub App device flow (github-auth/); the gh
 * CLI is not required. Repository, branch and organization lookups use the
 * GitHub REST API with the app's user token. Only `gh repo create --push`
 * still shells out (it creates the repo and pushes the local project).
 */

import { ipcMain, shell, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IPC_CHANNELS } from '../../../shared/constants';
import { GITHUB_REPO_NOT_FOUND_ERROR } from '../../../shared/constants/github';
import type { GitHubAppAccess, IPCResult } from '../../../shared/types';
import { getGitHubAppAccess } from '../../github-auth/app-access';
import { getAugmentedEnv, findExecutable } from '../../env-utils';
import { getToolPath } from '../../cli-tool-manager';
import { pollForToken, requestDeviceCode } from '../../github-auth/device-flow';
import { clearGitHubAuth, getValidAccessToken, loadGitHubAuth, saveGitHubAuth } from '../../github-auth/token-store';

const execFileAsync = promisify(execFile);

/**
 * Send device code info to all renderer windows immediately when extracted
 * This allows the UI to display the code while the auth process is still running
 */
function sendDeviceCodeToRenderer(deviceCode: string, authUrl: string, browserOpened: boolean): void {
  debugLog('Sending device code to renderer windows');
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC_CHANNELS.GITHUB_AUTH_DEVICE_CODE, {
      deviceCode,
      authUrl,
      browserOpened
    });
  }
}

/**
 * Payload for GitHub auth change event
 */
interface GitHubAuthChangedPayload {
  oldUsername: string | null;
  newUsername: string;
}

/**
 * Send auth change notification to all renderer windows
 * This notifies the UI that GitHub authentication has changed (e.g., account swap)
 */
function sendAuthChangedToRenderer(oldUsername: string | null, newUsername: string): void {
  debugLog('Sending auth changed event to renderer windows', { oldUsername, newUsername });
  const windows = BrowserWindow.getAllWindows();
  const payload: GitHubAuthChangedPayload = {
    oldUsername,
    newUsername
  };
  for (const win of windows) {
    win.webContents.send(IPC_CHANNELS.GITHUB_AUTH_CHANGED, payload);
  }
  // Uses EventEmitter.emit (not IPC send) so main-process listeners can react.
  // The listener (PRReviewStateManager) intentionally ignores all args — it only
  // needs the event signal, not the payload.
  ipcMain.emit(IPC_CHANNELS.GITHUB_AUTH_CHANGED, payload);
}

const GITHUB_API = 'https://api.github.com';

/** A GitHub REST call that answered with an error status. */
class GitHubHttpError extends Error {
  constructor(readonly status: number, path: string) {
    super(`GitHub API ${path} returned HTTP ${status}`);
    this.name = 'GitHubHttpError';
  }
}

/** GET a GitHub REST endpoint with the app's user token; follows `Link: rel="next"` up to `maxPages`. */
async function githubGet<T>(path: string, token: string, maxPages = 1): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = `${GITHUB_API}${path}`;
  for (let page = 0; url && page < maxPages; page++) {
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new GitHubHttpError(response.status, path);
    const body = (await response.json()) as T | T[];
    if (Array.isArray(body)) results.push(...body);
    else results.push(body);
    url = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return results;
}

async function requireToken(): Promise<string> {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Not signed in to GitHub. Please sign in first.');
  return token;
}

/** GET /user with the app's user token. */
async function fetchGitHubUser(token: string): Promise<{ login: string; name?: string } | null> {
  try {
    const [user] = await githubGet<{ login: string; name?: string | null }>('/user', token);
    return user ? { login: user.login, name: user.name ?? undefined } : null;
  } catch {
    return null;
  }
}

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data !== undefined) {
      console.warn(`[GitHub OAuth] ${message}`, data);
    } else {
      console.warn(`[GitHub OAuth] ${message}`);
    }
  }
}

// Regex pattern to validate GitHub repository format (owner/repo)
// Allows alphanumeric characters, hyphens, underscores, and periods
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Validate that a repository string matches the expected owner/repo format
 * Prevents command injection by rejecting strings with shell metacharacters
 */
function isValidGitHubRepo(repo: string): boolean {
  return GITHUB_REPO_PATTERN.test(repo);
}

const GITHUB_DEVICE_URL = 'https://github.com/login/device';

/**
 * Whether the gh CLI is installed. Not needed to sign in; used by features
 * that still run gh (creating a repository with --push).
 */
export function registerCheckGhCli(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CHECK_CLI,
    async (): Promise<IPCResult<{ installed: boolean; version?: string }>> => {
      if (!findExecutable('gh')) return { success: true, data: { installed: false } };
      try {
        const { stdout } = await execFileAsync(getToolPath('gh'), ['--version'], { encoding: 'utf-8', env: getAugmentedEnv() });
        return { success: true, data: { installed: true, version: stdout.trim().split('\n')[0] } };
      } catch {
        return { success: true, data: { installed: false } };
      }
    }
  );
}

/**
 * Check if user is authenticated with gh CLI
 * Uses augmented PATH to find gh CLI in common locations (e.g., Homebrew on macOS)
 */
export function registerCheckGhAuth(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CHECK_AUTH,
    async (): Promise<IPCResult<{ authenticated: boolean; username?: string }>> => {
      const token = await getValidAccessToken();
      if (!token) return { success: true, data: { authenticated: false } };
      const user = await fetchGitHubUser(token);
      return { success: true, data: { authenticated: true, username: user?.login ?? loadGitHubAuth()?.login } };
    }
  );
}

/**
 * Result type for GitHub auth start, including device flow information
 */
interface GitHubAuthStartResult {
  success: boolean;
  message?: string;
  deviceCode?: string;
  authUrl?: string;
  browserOpened?: boolean;
  /**
   * Fallback URL provided when browser launch fails.
   * The frontend should display this URL so users can manually navigate to complete auth.
   */
  fallbackUrl?: string;
}

/**
 * Start GitHub OAuth flow using gh CLI
 * This will extract the device code from gh CLI output and open the browser
 * using Electron's shell.openExternal (bypasses macOS child process restrictions)
 *
 * Detects account changes and emits GITHUB_AUTH_CHANGED event when the authenticated
 * account differs from the previous one (or when going from unauthenticated to authenticated).
 */
let activeSignIn: AbortController | null = null;

export function registerStartGhAuth(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_START_AUTH,
    async (): Promise<IPCResult<GitHubAuthStartResult>> => {
      const usernameBeforeAuth = loadGitHubAuth()?.login ?? null;
      activeSignIn?.abort();
      const controller = new AbortController();
      activeSignIn = controller;

      let code: Awaited<ReturnType<typeof requestDeviceCode>> | undefined;
      let browserOpened = false;
      try {
        code = await requestDeviceCode();
        try {
          await shell.openExternal(code.verificationUri);
          browserOpened = true;
        } catch {
          browserOpened = false;
        }
        sendDeviceCodeToRenderer(code.userCode, code.verificationUri, browserOpened);

        const tokens = await pollForToken(code, { signal: controller.signal });
        const user = await fetchGitHubUser(tokens.accessToken);
        saveGitHubAuth({ ...tokens, login: user?.login });

        if (user?.login && user.login !== usernameBeforeAuth) {
          sendAuthChangedToRenderer(usernameBeforeAuth, user.login);
        }
        return {
          success: true,
          data: {
            success: true,
            message: 'Signed in to GitHub',
            deviceCode: code.userCode,
            authUrl: code.verificationUri,
            browserOpened,
            fallbackUrl: browserOpened ? undefined : code.verificationUri,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'GitHub sign-in failed';
        return {
          success: false,
          error: message,
          data: {
            success: false,
            message,
            deviceCode: code?.userCode,
            authUrl: code?.verificationUri ?? GITHUB_DEVICE_URL,
            browserOpened,
            fallbackUrl: code?.verificationUri ?? GITHUB_DEVICE_URL,
          },
        };
      } finally {
        if (activeSignIn === controller) activeSignIn = null;
      }
    }
  );
}

/** Cancel an in-progress sign-in (the dialog was closed). */
export function registerCancelGhAuth(): void {
  ipcMain.handle(IPC_CHANNELS.GITHUB_CANCEL_AUTH, async (): Promise<IPCResult> => {
    activeSignIn?.abort();
    activeSignIn = null;
    return { success: true };
  });
}

/** Forget the stored GitHub App token. */
export function registerSignOutGh(): void {
  ipcMain.handle(IPC_CHANNELS.GITHUB_SIGN_OUT, async (): Promise<IPCResult> => {
    activeSignIn?.abort();
    activeSignIn = null;
    const previous = loadGitHubAuth()?.login ?? null;
    clearGitHubAuth();
    if (previous) sendAuthChangedToRenderer(previous, '');
    return { success: true };
  });
}

/**
 * The current GitHub App user token (refreshed when needed).
 */
export function registerGetGhToken(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_TOKEN,
    async (): Promise<IPCResult<{ token: string }>> => {
      const token = await getValidAccessToken();
      return token
        ? { success: true, data: { token } }
        : { success: false, error: 'Not signed in to GitHub. Please sign in first.' };
    }
  );
}

/**
 * Get the authenticated GitHub user info
 */
export function registerGetGhUser(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_USER,
    async (): Promise<IPCResult<{ username: string; name?: string }>> => {
      const token = await getValidAccessToken();
      const user = token ? await fetchGitHubUser(token) : null;
      return user
        ? { success: true, data: { username: user.login, name: user.name } }
        : { success: false, error: 'Not signed in to GitHub. Please sign in first.' };
    }
  );
}

/**
 * Repositories the signed-in user can reach through the app installation.
 */
export function registerListUserRepos(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_LIST_USER_REPOS,
    async (): Promise<IPCResult<{ repos: Array<{ fullName: string; description: string | null; isPrivate: boolean }> }>> => {
      try {
        const token = await requireToken();
        const repos = await githubGet<{ full_name: string; description: string | null; private: boolean }>(
          '/user/repos?per_page=100&sort=updated',
          token,
          3,
        );
        return {
          success: true,
          data: { repos: repos.map((r) => ({ fullName: r.full_name, description: r.description, isPrivate: r.private })) },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to list repositories' };
      }
    }
  );
}

/**
 * Detect the GitHub repository (owner/repo) from the project's origin remote.
 */
export function registerDetectGitHubRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_DETECT_REPO,
    async (_event: Electron.IpcMainInvokeEvent, projectPath: string): Promise<IPCResult<string>> => {
      try {
        const { stdout } = await execFileAsync(getToolPath('git'), ['remote', 'get-url', 'origin'], {
          encoding: 'utf-8',
          cwd: projectPath,
          env: getAugmentedEnv(),
        });
        const match = stdout.trim().match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
        return match ? { success: true, data: match[1] } : { success: false, error: 'Remote URL is not a GitHub repository' };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to detect GitHub repository' };
      }
    }
  );
}

/**
 * Branch names of a repository.
 */
export function registerGetGitHubBranches(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_BRANCHES,
    async (_event: Electron.IpcMainInvokeEvent, repo: string): Promise<IPCResult<string[]>> => {
      if (!isValidGitHubRepo(repo)) {
        return { success: false, error: 'Invalid repository format. Expected: owner/repo' };
      }
      try {
        const token = await requireToken();
        const branches = await githubGet<{ name: string }>(`/repos/${repo}/branches?per_page=100`, token, 10);
        return { success: true, data: branches.map((b) => b.name) };
      } catch (error) {
        // With the app's token, 404 means the app is not installed on the repository (or it does not exist)
        if (error instanceof GitHubHttpError && error.status === 404) return { success: false, error: GITHUB_REPO_NOT_FOUND_ERROR };
        return { success: false, error: error instanceof Error ? error.message : 'Failed to get branches' };
      }
    }
  );
}

/**
 * Whether the GitHub App is installed (signing in only authorizes it), optionally for one repository.
 */
export function registerGetGitHubAppAccess(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_APP_ACCESS,
    async (_event: Electron.IpcMainInvokeEvent, repo?: string): Promise<IPCResult<GitHubAppAccess>> => {
      if (repo !== undefined && !isValidGitHubRepo(repo)) {
        return { success: false, error: 'Invalid repository format. Expected: owner/repo' };
      }
      const [owner, name] = repo ? repo.split('/') : [];
      const access = await getGitHubAppAccess(repo ? { owner, repo: name } : undefined);
      return 'error' in access ? { success: false, error: access.error } : { success: true, data: access };
    }
  );
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Create a GitHub repository from a local project and push it (gh CLI).
 */
export function registerCreateGitHubRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CREATE_REPO,
    async (
      _event: Electron.IpcMainInvokeEvent,
      repoName: string,
      options: { description?: string; isPrivate?: boolean; projectPath: string; owner?: string }
    ): Promise<IPCResult<{ fullName: string; url: string }>> => {
      if (!NAME_PATTERN.test(repoName)) {
        return { success: false, error: 'Invalid repository name. Use only letters, numbers, hyphens, underscores, and periods.' };
      }
      if (options.owner && !NAME_PATTERN.test(options.owner)) {
        return { success: false, error: 'Invalid owner name.' };
      }
      try {
        const token = await requireToken();
        const user = await fetchGitHubUser(token);
        if (!user) throw new Error('Could not read the signed-in GitHub user');
        const owner = options.owner || user.login;
        const args = [
          'repo',
          'create',
          owner === user.login ? repoName : `${owner}/${repoName}`,
          '--source',
          options.projectPath,
          options.isPrivate ? '--private' : '--public',
          '--push',
        ];
        if (options.description) args.push('--description', options.description);

        await execFileAsync(getToolPath('gh'), args, {
          encoding: 'utf-8',
          cwd: options.projectPath,
          env: { ...getAugmentedEnv(), GH_TOKEN: token },
        });
        const fullName = `${owner}/${repoName}`;
        return { success: true, data: { fullName, url: `https://github.com/${fullName}` } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to create repository' };
      }
    }
  );
}

/**
 * Point the local repository's origin at a GitHub repository.
 */
export function registerAddGitRemote(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_ADD_REMOTE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      projectPath: string,
      repoFullName: string
    ): Promise<IPCResult<{ remoteUrl: string }>> => {
      if (!isValidGitHubRepo(repoFullName)) {
        return { success: false, error: 'Invalid repository format. Expected: owner/repo' };
      }
      const remoteUrl = `https://github.com/${repoFullName}.git`;
      const git = (args: string[]) =>
        execFileAsync(getToolPath('git'), args, { cwd: projectPath, encoding: 'utf-8', env: getAugmentedEnv() });
      try {
        try {
          await git(['remote', 'get-url', 'origin']);
          await git(['remote', 'set-url', 'origin', remoteUrl]);
        } catch {
          await git(['remote', 'add', 'origin', remoteUrl]);
        }
        return { success: true, data: { remoteUrl } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to add remote' };
      }
    }
  );
}

/**
 * Organizations of the signed-in user (empty when none or on error).
 */
export function registerListGitHubOrgs(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_LIST_ORGS,
    async (): Promise<IPCResult<{ orgs: Array<{ login: string; avatarUrl?: string }> }>> => {
      try {
        const token = await requireToken();
        const orgs = await githubGet<{ login: string; avatar_url?: string }>('/user/orgs?per_page=100', token, 3);
        return { success: true, data: { orgs: orgs.map((o) => ({ login: o.login, avatarUrl: o.avatar_url })) } };
      } catch {
        return { success: true, data: { orgs: [] } };
      }
    }
  );
}

/**
 * Register all GitHub OAuth handlers
 */
export function registerGithubOAuthHandlers(): void {
  debugLog('Registering GitHub OAuth handlers');
  registerCheckGhCli();
  registerCheckGhAuth();
  registerStartGhAuth();
  registerCancelGhAuth();
  registerSignOutGh();
  registerGetGhToken();
  registerGetGhUser();
  registerListUserRepos();
  registerDetectGitHubRepo();
  registerGetGitHubBranches();
  registerGetGitHubAppAccess();
  registerCreateGitHubRepo();
  registerAddGitRemote();
  registerListGitHubOrgs();
  debugLog('GitHub OAuth handlers registered');
}
