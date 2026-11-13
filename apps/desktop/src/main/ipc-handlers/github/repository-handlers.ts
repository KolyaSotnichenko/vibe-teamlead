/**
 * GitHub repository-related IPC handlers
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, GitHubSyncStatus } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getGitHubConfigAsync, githubFetch, normalizeRepoReference } from './utils';

/**
 * Check GitHub connection status
 */
export function registerCheckConnection(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CHECK_CONNECTION,
    async (_, projectId: string): Promise<IPCResult<GitHubSyncStatus>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = await getGitHubConfigAsync(project);
      if (!config) {
        return {
          success: true,
          data: {
            connected: false,
            error: 'No GitHub token or repository configured'
          }
        };
      }

      try {
        // Normalize repo reference (handles full URLs, git URLs, etc.)
        const normalizedRepo = normalizeRepoReference(config.repo);
        if (!normalizedRepo) {
          return {
            success: true,
            data: {
              connected: false,
              error: 'Invalid repository format. Use owner/repo or GitHub URL.'
            }
          };
        }

        // Fetch repo info
        const repoData = await githubFetch(
          config.token,
          `/repos/${normalizedRepo}`
        ) as { full_name: string; description?: string };

        // Count open issues
        const issuesData = await githubFetch(
          config.token,
          `/repos/${normalizedRepo}/issues?state=open&per_page=1`
        ) as unknown[];

        const openCount = Array.isArray(issuesData) ? issuesData.length : 0;

        return {
          success: true,
          data: {
            connected: true,
            repoFullName: repoData.full_name,
            repoDescription: repoData.description,
            issueCount: openCount,
            lastSyncedAt: new Date().toISOString()
          }
        };
      } catch (error) {
        return {
          success: true,
          data: {
            connected: false,
            error: error instanceof Error ? error.message : 'Failed to connect to GitHub'
          }
        };
      }
    }
  );
}

/**
 * Get list of GitHub repositories (personal + organization)
 */
export function registerGetRepositories(): void {
}

/**
 * Register all repository-related handlers
 */
export function registerRepositoryHandlers(): void {
  registerCheckConnection();
  registerGetRepositories();
}
