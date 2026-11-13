/**
 * GitLab OAuth handlers using GitLab CLI (glab)
 * Provides OAuth flow similar to GitHub's gh CLI
 */

import { ipcMain, shell } from 'electron';
import { execFileSync, spawn } from 'child_process';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import { getAugmentedEnv, findExecutable } from '../../env-utils';
import { openTerminalWithCommand } from '../claude-code-handlers';
import type { GitLabAuthStartResult } from './types';

// Debug logging helper - requires BOTH development mode AND DEBUG flag for OAuth handlers
// This is intentionally more restrictive than other handlers to prevent accidental token logging
const DEBUG = process.env.NODE_ENV === 'development' && process.env.DEBUG === 'true';

/**
 * Redact sensitive information from data before logging
 */
function redactSensitiveData(data: unknown): unknown {
  if (typeof data === 'string') {
    // Redact anything that looks like a token (glpat-*, private token patterns)
    return data.replace(/glpat-[A-Za-z0-9_-]+/g, 'glpat-[REDACTED]')
               .replace(/private[_-]?token[=:]\s*["']?[A-Za-z0-9_-]+["']?/gi, 'private_token=[REDACTED]');
  }
  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data)) {
      return data.map(redactSensitiveData);
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Redact known sensitive keys
      if (/token|password|secret|credential|auth/i.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitiveData(value);
      }
    }
    return result;
  }
  return data;
}

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data !== undefined) {
      console.debug(`[GitLab OAuth] ${message}`, redactSensitiveData(data));
    } else {
      console.debug(`[GitLab OAuth] ${message}`);
    }
  }
}

/**
 * Extract hostname from instance URL
 */
function getHostnameFromUrl(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).hostname;
  } catch {
    return 'gitlab.com';
  }
}

/**
 * Check if glab CLI is installed
 */
export function registerCheckGlabCli(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_CHECK_CLI,
    async (): Promise<IPCResult<{ installed: boolean; version?: string }>> => {
      debugLog('checkGitLabCli handler called');
      try {
        const glabPath = findExecutable('glab');
        if (!glabPath) {
          debugLog('glab CLI not found in PATH or common locations');
          return {
            success: true,
            data: { installed: false }
          };
        }
        debugLog('glab CLI found at:', glabPath);

        const versionOutput = execFileSync('glab', ['--version'], {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        });
        const version = versionOutput.trim().split('\n')[0];
        debugLog('glab version:', version);

        return {
          success: true,
          data: { installed: true, version }
        };
      } catch (error) {
        debugLog('glab CLI not found or error:', error instanceof Error ? error.message : error);
        return {
          success: true,
          data: { installed: false }
        };
      }
    }
  );
}

/**
 * Install glab CLI by opening a terminal with the appropriate install command
 * Uses the user's preferred terminal from settings
 */
export function registerInstallGlabCli(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_INSTALL_CLI,
    async (): Promise<IPCResult<{ command: string }>> => {
      debugLog('installGitLabCli handler called');
      try {
        const platform = process.platform;
        let command: string;

        if (platform === 'darwin') {
          // macOS: Use Homebrew
          command = 'brew install glab';
        } else if (platform === 'win32') {
          // Windows: Use winget
          command = 'winget install --id GitLab.glab';
        } else {
          // Linux: Try snap first, then homebrew
          command = 'sudo snap install glab || brew install glab';
        }

        debugLog('Install command:', command);
        debugLog('Opening terminal...');
        await openTerminalWithCommand(command);
        debugLog('Terminal opened successfully');

        return {
          success: true,
          data: { command }
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        debugLog('Install failed:', errorMsg);
        return {
          success: false,
          error: `Failed to open terminal for installation: ${errorMsg}`
        };
      }
    }
  );
}

/**
 * Check if user is authenticated with glab CLI
 */
export function registerCheckGlabAuth(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_CHECK_AUTH,
    async (_event, instanceUrl?: string): Promise<IPCResult<{ authenticated: boolean; username?: string }>> => {
      debugLog('checkGitLabAuth handler called', { instanceUrl });
      const env = getAugmentedEnv();
      const hostname = instanceUrl ? getHostnameFromUrl(instanceUrl) : 'gitlab.com';

      try {
        // Check auth status for the specific host
        const args = ['auth', 'status'];
        if (hostname !== 'gitlab.com') {
          args.push('--hostname', hostname);
        }

        debugLog('Running: glab', args);
        execFileSync('glab', args, { encoding: 'utf-8', stdio: 'pipe', env });

        // Get username if authenticated
        try {
          const userArgs = ['api', 'user', '--jq', '.username'];
          if (hostname !== 'gitlab.com') {
            userArgs.push('--hostname', hostname);
          }
          const username = execFileSync('glab', userArgs, {
            encoding: 'utf-8',
            stdio: 'pipe',
            env
          }).trim();
          debugLog('Username:', username);

          return {
            success: true,
            data: { authenticated: true, username }
          };
        } catch {
          return {
            success: true,
            data: { authenticated: true }
          };
        }
      } catch (error) {
        debugLog('Auth check failed:', error instanceof Error ? error.message : error);
        return {
          success: true,
          data: { authenticated: false }
        };
      }
    }
  );
}

/**
 * Start GitLab OAuth flow using glab CLI
 */
export function registerStartGlabAuth(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_START_AUTH,
    async (_event, instanceUrl?: string): Promise<IPCResult<GitLabAuthStartResult>> => {
      debugLog('startGitLabAuth handler called', { instanceUrl });
      const hostname = instanceUrl ? getHostnameFromUrl(instanceUrl) : 'gitlab.com';
      const deviceUrl = instanceUrl
        ? `${instanceUrl.replace(/\/$/, '')}/-/profile/personal_access_tokens`
        : 'https://gitlab.com/-/profile/personal_access_tokens';

      return new Promise((resolve) => {
        try {
          // glab auth login with web flow
          const args = ['auth', 'login', '--web'];
          if (hostname !== 'gitlab.com') {
            args.push('--hostname', hostname);
          }

          debugLog('Spawning: glab', args);

          const glabProcess = spawn('glab', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: getAugmentedEnv()
          });

          let _output = '';
          let errorOutput = '';
          let browserOpened = false;

          glabProcess.stdout?.on('data', (data) => {
            const chunk = data.toString('utf-8');
            _output += chunk;
            debugLog('glab stdout:', chunk);

            // Try to open browser if URL detected
            const urlMatch = chunk.match(/https?:\/\/[^\s]+/);
            if (urlMatch && !browserOpened) {
              browserOpened = true;
              shell.openExternal(urlMatch[0]).catch((err) => {
                debugLog('Failed to open browser:', err);
              });
            }
          });

          glabProcess.stderr?.on('data', (data) => {
            const chunk = data.toString('utf-8');
            errorOutput += chunk;
            debugLog('glab stderr:', chunk);
          });

          glabProcess.on('close', (code) => {
            debugLog('glab process exited with code:', code);

            if (code === 0) {
              resolve({
                success: true,
                data: {
                  deviceCode: '',
                  verificationUrl: deviceUrl,
                  userCode: ''
                }
              });
            } else {
              resolve({
                success: false,
                error: errorOutput || `Authentication failed with exit code ${code}`,
                data: {
                  deviceCode: '',
                  verificationUrl: deviceUrl,
                  userCode: ''
                }
              });
            }
          });

          glabProcess.on('error', (error) => {
            debugLog('glab process error:', error.message);
            resolve({
              success: false,
              error: error.message,
              data: {
                deviceCode: '',
                verificationUrl: deviceUrl,
                userCode: ''
              }
            });
          });
        } catch (error) {
          debugLog('Exception in startGitLabAuth:', error instanceof Error ? error.message : error);
          resolve({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            data: {
              deviceCode: '',
              verificationUrl: deviceUrl,
              userCode: ''
            }
          });
        }
      });
    }
  );
}

/**
 * Get the current GitLab auth token from glab CLI
 */
export function registerGetGlabToken(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_GET_TOKEN,
    async (_event, instanceUrl?: string): Promise<IPCResult<{ token: string }>> => {
      debugLog('getGitLabToken handler called', { instanceUrl });
      const hostname = instanceUrl ? getHostnameFromUrl(instanceUrl) : 'gitlab.com';

      try {
        const args = ['auth', 'token'];
        if (hostname !== 'gitlab.com') {
          args.push('--hostname', hostname);
        }

        const token = execFileSync('glab', args, {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        }).trim();

        if (!token) {
          return {
            success: false,
            error: 'No token found. Please authenticate first.'
          };
        }

        return {
          success: true,
          data: { token }
        };
      } catch (error) {
        debugLog('Failed to get token:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get token'
        };
      }
    }
  );
}

/**
 * Get the authenticated GitLab user info
 */
export function registerGetGlabUser(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_GET_USER,
    async (_event, instanceUrl?: string): Promise<IPCResult<{ username: string; name?: string }>> => {
      debugLog('getGitLabUser handler called', { instanceUrl });
      const hostname = instanceUrl ? getHostnameFromUrl(instanceUrl) : 'gitlab.com';

      try {
        const args = ['api', 'user'];
        if (hostname !== 'gitlab.com') {
          args.push('--hostname', hostname);
        }

        const userJson = execFileSync('glab', args, {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        });

        const user = JSON.parse(userJson);
        debugLog('Parsed user:', { username: user.username, name: user.name });

        return {
          success: true,
          data: {
            username: user.username,
            name: user.name
          }
        };
      } catch (error) {
        debugLog('Failed to get user info:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get user info'
        };
      }
    }
  );
}

/**
 * List projects accessible to the authenticated user
 */
export function registerListUserProjects(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS,
    async (_event, instanceUrl?: string): Promise<IPCResult<{ projects: Array<{ pathWithNamespace: string; description: string | null; visibility: string }> }>> => {
      debugLog('listUserProjects handler called', { instanceUrl });
      const hostname = instanceUrl ? getHostnameFromUrl(instanceUrl) : 'gitlab.com';

      try {
        const args = ['repo', 'list', '--mine', '-F', 'json'];
        if (hostname !== 'gitlab.com') {
          args.push('--hostname', hostname);
        }

        const output = execFileSync('glab', args, {
          encoding: 'utf-8',
          stdio: 'pipe',
          env: getAugmentedEnv()
        });

        const projects = JSON.parse(output);
        debugLog('Found projects:', projects.length);

        const formattedProjects = projects.map((p: { path_with_namespace: string; description: string | null; visibility: string }) => ({
          pathWithNamespace: p.path_with_namespace,
          description: p.description,
          visibility: p.visibility
        }));

        return {
          success: true,
          data: { projects: formattedProjects }
        };
      } catch (error) {
        debugLog('Failed to list projects:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list projects'
        };
      }
    }
  );
}

/**
 * Detect GitLab project from git remote origin
 */
export function registerDetectGitLabProject(): void {
}

/**
 * Get branches from GitLab project
 */
export function registerGetGitLabBranches(): void {
}

/**
 * Create a new GitLab project
 */
export function registerCreateGitLabProject(): void {
}

/**
 * Add a remote origin to a local git repository
 */
export function registerAddGitLabRemote(): void {
}

/**
 * List user's GitLab groups
 */
export function registerListGitLabGroups(): void {
}

/**
 * Register all GitLab OAuth handlers
 */
export function registerGitlabOAuthHandlers(): void {
  debugLog('Registering GitLab OAuth handlers');
  registerCheckGlabCli();
  registerInstallGlabCli();
  registerCheckGlabAuth();
  registerStartGlabAuth();
  registerGetGlabToken();
  registerGetGlabUser();
  registerListUserProjects();
  registerDetectGitLabProject();
  registerGetGitLabBranches();
  registerCreateGitLabProject();
  registerAddGitLabRemote();
  registerListGitLabGroups();
  debugLog('GitLab OAuth handlers registered');
}
