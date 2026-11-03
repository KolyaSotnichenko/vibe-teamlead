/**
 * GitHub OAuth handlers using GitHub CLI (gh)
 * Provides a simpler OAuth flow than manual PAT creation
 */

import { ipcMain, shell, BrowserWindow } from 'electron';
import { execSync, execFileSync, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import { getAugmentedEnv, findExecutable } from '../../env-utils';
import { getToolPath } from '../../cli-tool-manager';
import { pollForToken, requestDeviceCode } from '../../github-auth/device-flow';
import { getValidAccessToken, loadGitHubAuth, saveGitHubAuth } from '../../github-auth/token-store';

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

/**
 * Get current GitHub username from gh CLI (async to avoid blocking main thread)
 * Returns null if not authenticated or on error
 */
async function getCurrentGitHubUsername(): Promise<string | null> {
  const token = await getValidAccessToken();
  if (!token) return null;
  return (await fetchGitHubUser(token))?.login ?? null;
}

/** GET /user with the app's user token. */
async function fetchGitHubUser(token: string): Promise<{ login: string; name?: string } | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const user = (await response.json()) as { login: string; name?: string };
    return { login: user.login, name: user.name ?? undefined };
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

// Regex patterns for parsing device code from gh CLI output
// Expected format: "! First copy your one-time code: XXXX-XXXX"
// Pattern updated to handle different gh CLI versions - supports:
// - "one-time code", "code", or "verification code" prefixes
// - Hyphen or space separator in the code (XXXX-XXXX or XXXX XXXX)
// Note: Separator is REQUIRED to avoid matching 8-char strings without separator
const DEVICE_CODE_PATTERN = /(?:one-time code|verification code|code):\s*([A-Z0-9]{4}[-\s][A-Z0-9]{4})/i;

// GitHub device flow URL pattern
const DEVICE_URL_PATTERN = /https:\/\/github\.com\/login\/device/i;

// Default GitHub device flow URL
const GITHUB_DEVICE_URL = 'https://github.com/login/device';

/**
 * Parse device code from gh CLI stdout output
 * Returns the device code (format: XXXX-XXXX) if found, null otherwise
 * Normalizes space separator to hyphen (GitHub always expects XXXX-XXXX)
 */
function parseDeviceCode(output: string): string | null {
  const match = output.match(DEVICE_CODE_PATTERN);
  if (match?.[1]) {
    // Normalize: replace space with hyphen (GitHub expects XXXX-XXXX format)
    const normalizedCode = match[1].replace(' ', '-');
    debugLog('Device code extracted successfully (code redacted for security)');
    return normalizedCode;
  }
  return null;
}

/**
 * Parse device URL from gh CLI output
 * Returns the URL if found, or the default GitHub device URL
 */
function parseDeviceUrl(output: string): string {
  const match = output.match(DEVICE_URL_PATTERN);
  if (match) {
    debugLog('Found device URL in output:', match[0]);
    return match[0];
  }
  // Default to standard GitHub device flow URL
  return GITHUB_DEVICE_URL;
}

/**
 * Result of parsing device flow output from gh CLI
 */
interface DeviceFlowInfo {
  deviceCode: string | null;
  authUrl: string;
}

/**
 * Parse both device code and URL from combined gh CLI output
 * Searches through both stdout and stderr as gh may output to either
 */
function parseDeviceFlowOutput(stdout: string, stderr: string): DeviceFlowInfo {
  const combinedOutput = `${stdout}\n${stderr}`;

  return {
    deviceCode: parseDeviceCode(combinedOutput),
    authUrl: parseDeviceUrl(combinedOutput)
  };
}

/**
 * Check if gh CLI is installed
 * Uses augmented PATH to find gh CLI in common locations (e.g., Homebrew on macOS)
 */
export function registerCheckGhCli(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CHECK_CLI,
    async (): Promise<IPCResult<{ installed: boolean; version?: string }>> => {
      debugLog('checkGitHubCli handler called');
      try {
        // Use findExecutable to check common locations including Homebrew paths
        const ghPath = findExecutable('gh');
        if (!ghPath) {
          debugLog('gh CLI not found in PATH or common locations');
          return {
            success: true,
            data: { installed: false }
          };
        }
        debugLog('gh CLI found at:', ghPath);

        // Get version using augmented environment
        debugLog('Getting gh version...');
        const versionOutput = execFileSync(getToolPath('gh'), ['--version'], {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        });
        const version = versionOutput.trim().split('\n')[0];
        debugLog('gh version:', version);

        return {
          success: true,
          data: { installed: true, version }
        };
      } catch (error) {
        debugLog('gh CLI not found or error:', error instanceof Error ? error.message : error);
        return {
          success: true,
          data: { installed: false }
        };
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

/**
 * Get the current GitHub auth token from gh CLI
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
 * List repositories accessible to the authenticated user
 */
export function registerListUserRepos(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_LIST_USER_REPOS,
    async (): Promise<IPCResult<{ repos: Array<{ fullName: string; description: string | null; isPrivate: boolean }> }>> => {
      debugLog('listUserRepos handler called');
      try {
        // Use gh repo list to get user's repositories
        // Format: owner/repo, description, visibility
        debugLog('Running: gh repo list --limit 100 --json nameWithOwner,description,isPrivate');
        const output = execSync(
          'gh repo list --limit 100 --json nameWithOwner,description,isPrivate',
          {
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getAugmentedEnv()
          }
        );

        const repos = JSON.parse(output);
        debugLog('Found repos:', repos.length);

        const formattedRepos = repos.map((repo: { nameWithOwner: string; description: string | null; isPrivate: boolean }) => ({
          fullName: repo.nameWithOwner,
          description: repo.description,
          isPrivate: repo.isPrivate
        }));

        return {
          success: true,
          data: { repos: formattedRepos }
        };
      } catch (error) {
        debugLog('Failed to list repos:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list repositories'
        };
      }
    }
  );
}

/**
 * Detect GitHub repository from git remote origin
 */
export function registerDetectGitHubRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_DETECT_REPO,
    async (_event: Electron.IpcMainInvokeEvent, projectPath: string): Promise<IPCResult<string>> => {
      debugLog('detectGitHubRepo handler called', { projectPath });
      try {
        // Get the remote URL
        debugLog('Running: git remote get-url origin');
        const remoteUrl = execFileSync(getToolPath('git'), ['remote', 'get-url', 'origin'], {
          encoding: 'utf-8',
          cwd: projectPath,
          stdio: 'pipe'
        }).trim();

        debugLog('Remote URL:', remoteUrl);

        // Parse GitHub repo from URL
        // Formats:
        // - https://github.com/owner/repo.git
        // - git@github.com:owner/repo.git
        // - https://github.com/owner/repo
        const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match) {
          const repo = match[1];
          debugLog('Detected repo:', repo);
          return {
            success: true,
            data: repo
          };
        }

        debugLog('Could not parse GitHub repo from URL');
        return {
          success: false,
          error: 'Remote URL is not a GitHub repository'
        };
      } catch (error) {
        debugLog('Failed to detect repo:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to detect GitHub repository'
        };
      }
    }
  );
}

/**
 * Get branches from GitHub repository
 */
export function registerGetGitHubBranches(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_BRANCHES,
    async (_event: Electron.IpcMainInvokeEvent, repo: string, _token: string): Promise<IPCResult<string[]>> => {
      debugLog('getGitHubBranches handler called', { repo });

      // Validate repo format to prevent command injection
      if (!isValidGitHubRepo(repo)) {
        debugLog('Invalid repo format rejected:', repo);
        return {
          success: false,
          error: 'Invalid repository format. Expected: owner/repo'
        };
      }

      try {
        // Use gh CLI to list branches (uses authenticated session)
        // Use execFileSync with separate arguments to avoid shell injection
        const apiEndpoint = `repos/${repo}/branches`;
        debugLog(`Running: gh api ${apiEndpoint} --paginate --jq '.[].name'`);
        const output = execFileSync(
          'gh',
          ['api', apiEndpoint, '--paginate', '--jq', '.[].name'],
          {
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getAugmentedEnv()
          }
        );

        const branches = output.trim().split('\n').filter(b => b.length > 0);
        debugLog('Found branches:', branches.length);

        return {
          success: true,
          data: branches
        };
      } catch (error) {
        debugLog('Failed to get branches:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get branches'
        };
      }
    }
  );
}

/**
 * Create a new GitHub repository using gh CLI
 */
export function registerCreateGitHubRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CREATE_REPO,
    async (
      _event: Electron.IpcMainInvokeEvent,
      repoName: string,
      options: { description?: string; isPrivate?: boolean; projectPath: string; owner?: string }
    ): Promise<IPCResult<{ fullName: string; url: string }>> => {
      debugLog('createGitHubRepo handler called', { repoName, options });

      // Validate repo name - only alphanumeric, hyphens, underscores
      if (!/^[A-Za-z0-9_.-]+$/.test(repoName)) {
        return {
          success: false,
          error: 'Invalid repository name. Use only letters, numbers, hyphens, underscores, and periods.'
        };
      }

      try {
        // Get the authenticated username
        const username = execFileSync(getToolPath('gh'), ['api', 'user', '--jq', '.login'], {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        }).trim();

        // Determine the owner (personal account or organization)
        const owner = options.owner || username;
        const isOrgRepo = owner !== username;

        // Build the full repo name (owner/repo format for orgs)
        const repoFullName = isOrgRepo ? `${owner}/${repoName}` : repoName;

        // Build gh repo create command arguments
        const args = ['repo', 'create', repoFullName, '--source', options.projectPath];

        if (options.isPrivate) {
          args.push('--private');
        } else {
          args.push('--public');
        }

        if (options.description) {
          args.push('--description', options.description);
        }

        // Push to remote after creation
        args.push('--push');

        debugLog('Running: gh', args);
        const output = execFileSync('gh', args, {
          encoding: 'utf-8',
          cwd: options.projectPath,
          stdio: 'pipe',
          env: getAugmentedEnv()
        });

        debugLog('gh repo create output:', output);

        const fullName = `${owner}/${repoName}`;
        const url = `https://github.com/${fullName}`;

        debugLog('Created repo:', { fullName, url });

        return {
          success: true,
          data: { fullName, url }
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create repository';
        debugLog('Failed to create repo:', errorMessage);
        return {
          success: false,
          error: errorMessage
        };
      }
    }
  );
}

/**
 * Add a remote origin to a local git repository
 */
export function registerAddGitRemote(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_ADD_REMOTE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      projectPath: string,
      repoFullName: string
    ): Promise<IPCResult<{ remoteUrl: string }>> => {
      debugLog('addGitRemote handler called', { projectPath, repoFullName });

      // Validate repo format
      if (!isValidGitHubRepo(repoFullName)) {
        return {
          success: false,
          error: 'Invalid repository format. Expected: owner/repo'
        };
      }

      const remoteUrl = `https://github.com/${repoFullName}.git`;

      try {
        // Check if origin already exists
        try {
          execFileSync(getToolPath('git'), ['remote', 'get-url', 'origin'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          // Origin exists, remove it first
          debugLog('Removing existing origin remote');
          execFileSync(getToolPath('git'), ['remote', 'remove', 'origin'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
        } catch {
          // No origin exists, which is fine
        }

        // Add the remote
        debugLog('Adding remote origin:', remoteUrl);
        execFileSync('git', ['remote', 'add', 'origin', remoteUrl], {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });

        debugLog('Remote added successfully');
        return {
          success: true,
          data: { remoteUrl }
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to add remote';
        debugLog('Failed to add remote:', errorMessage);
        return {
          success: false,
          error: errorMessage
        };
      }
    }
  );
}

/**
 * List user's GitHub organizations
 */
export function registerListGitHubOrgs(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_LIST_ORGS,
    async (): Promise<IPCResult<{ orgs: Array<{ login: string; avatarUrl?: string }> }>> => {
      debugLog('listGitHubOrgs handler called');

      try {
        // Get user's organizations
        const output = execFileSync(getToolPath('gh'), ['api', 'user/orgs', '--jq', '.[] | {login: .login, avatarUrl: .avatar_url}'], {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        });

        // Parse the JSON lines output
        const orgs: Array<{ login: string; avatarUrl?: string }> = [];
        const lines = output.trim().split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const org = JSON.parse(line);
            orgs.push({
              login: org.login,
              avatarUrl: org.avatarUrl
            });
          } catch {
            // Skip invalid JSON lines
          }
        }

        debugLog('Found organizations:', orgs.length);
        return {
          success: true,
          data: { orgs }
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to list organizations';
        debugLog('Failed to list orgs:', errorMessage);
        return {
          success: true, // Return success with empty array - user might not have any orgs
          data: { orgs: [] }
        };
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
  registerGetGhToken();
  registerGetGhUser();
  registerListUserRepos();
  registerDetectGitHubRepo();
  registerGetGitHubBranches();
  registerCreateGitHubRepo();
  registerAddGitRemote();
  registerListGitHubOrgs();
  debugLog('GitHub OAuth handlers registered');
}
