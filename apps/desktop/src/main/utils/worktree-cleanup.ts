/**
 * Worktree Cleanup Utility
 *
 * Provides a robust, cross-platform worktree cleanup implementation that handles
 * Windows-specific issues with git worktree deletion when untracked files exist.
 *
 * The standard `git worktree remove --force` fails on Windows when the worktree
 * contains untracked files (node_modules, build artifacts, etc.). This utility:
 *
 * 1. Manually deletes the worktree directory with retry logic for file locks
 *    (falls back to shell `rm -rf` on Unix when Node.js rm() fails)
 * 2. Prunes git's internal worktree references
 * 3. Optionally deletes the associated branch
 *
 * Related issue: upstream issue #1539
 */

import { execFileSync } from 'child_process';
import { rm } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { chmod, cp, lstat, mkdir, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { getSpecsDir, isTaskBranch } from '../../shared/constants/config';
import { taskLogService } from '../task-log-service';
import { getToolPath } from '../cli-tool-manager';
import { stopStorybooksUnder } from '../design/storybook-service';
import { removeTaskContainers } from './task-containers';
import { releaseTaskPreview } from '../preview/preview-session';
import { getIsolatedGitEnv } from './git-isolation';
import { withoutGitHooks } from '../ai/merge/git-merge';
import { getTaskWorktreeDir, getTerminalWorktreeDir, isPathWithinBase } from '../worktree-paths';

/**
 * Options for worktree cleanup operation
 */
export interface WorktreeCleanupOptions {
  /** Absolute path to the worktree directory to delete */
  worktreePath: string;
  /** Absolute path to the main project directory (for git operations) */
  projectPath: string;
  /** Spec ID for generating branch name (e.g., "001-my-feature") */
  specId: string;
  /** Log prefix for console messages (e.g., "[TASK_DELETE]") */
  logPrefix?: string;
  /** Whether to delete the associated branch (default: true) */
  deleteBranch?: boolean;
  /** Explicit branch name to use for deletion (overrides auto-detection fallback) */
  branchName?: string;
  /** Timeout in milliseconds for git operations (default: 30000) */
  timeout?: number;
  /** Maximum retries for directory deletion on Windows (default: 3) */
  maxRetries?: number;
  /** Delay between retries in milliseconds (default: 500) */
  retryDelay?: number;
  /** Specs folder relative to the project (project.autoBuildPath + "/specs"); defaults to .vibe-teamlead/specs */
  specsRelPath?: string;
}

/**
 * Result of the cleanup operation
 */
export interface WorktreeCleanupResult {
  /** Whether the cleanup was successful */
  success: boolean;
  /** The branch that was deleted (if deleteBranch was true) */
  branch?: string;
  /** Warnings that occurred during cleanup (non-fatal issues) */
  warnings: string[];
}

/**
 * Gets the worktree branch name based on spec ID
 */
function getWorktreeBranch(worktreePath: string, specId: string, timeout: number, explicitBranchName?: string): string | null {
  // First try to get branch from the worktree's HEAD — only when the folder still is
  // its own worktree. A leftover folder inside the project makes git answer for the
  // project itself (e.g. "main"), and that branch must never be deleted.
  if (existsSync(path.join(worktreePath, '.git'))) {
    try {
      const top = execFileSync(getToolPath('git'), ['rev-parse', '--show-toplevel'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
        timeout
      }).trim();
      const branch = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
        timeout
      }).trim();

      if (branch && branch !== 'HEAD' && realpathSync(top) === realpathSync(worktreePath)) {
        return branch;
      }
    } catch {
      // Worktree might be corrupted, fall back to explicit name or naming convention
    }
  }

  // Use explicit branch name if provided (e.g., terminal worktrees use terminal/{name})
  if (explicitBranchName) {
    return explicitBranchName;
  }

  // Fall back to the naming convention: vibe-teamlead/{spec-id}
  return `vibe-teamlead/${specId}`;
}

/**
 * Delays execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Copies the task's spec folder from the worktree back to the project before
 * the worktree is deleted. While a task builds, the agents write their logs,
 * QA report, security results, design check and architecture into the
 * worktree's copy (the specs folder is not in git, so a merge doesn't carry
 * it); without this, a merged task showed only planning logs and an empty
 * Security tab. task_logs.json is merged (planning lives in the project's
 * copy, coding and QA in the worktree's); everything else is the worktree's
 * newer version.
 */
export async function preserveTaskSpec(
  worktreePath: string,
  projectPath: string,
  specId: string,
  specsRelPath: string = getSpecsDir(undefined)
): Promise<void> {
  const worktreeSpecDir = path.join(worktreePath, specsRelPath, specId);
  if (!existsSync(worktreeSpecDir)) return;
  const mainSpecDir = path.join(projectPath, specsRelPath, specId);
  const mergedLogs = existsSync(path.join(worktreeSpecDir, 'task_logs.json'))
    ? taskLogService.mergeSpecDirLogs(mainSpecDir, worktreeSpecDir)
    : null;

  await mkdir(mainSpecDir, { recursive: true });
  const topLogs = path.join(worktreeSpecDir, 'task_logs.json');
  await cp(worktreeSpecDir, mainSpecDir, {
    recursive: true,
    force: true,
    // Only regular files and folders: a symlink could point anywhere
    filter: async (src) => src !== topLogs && !(await lstat(src)).isSymbolicLink(),
  });
  if (mergedLogs) {
    await writeFile(path.join(mainSpecDir, 'task_logs.json'), JSON.stringify(mergedLogs, null, 2));
  }
}

/**
 * Adds owner write (and, for folders, search) permission to everything under
 * `dirPath`. Package managers leave read-only trees behind (the pnpm store
 * writes its files and folders without write permission), and a folder
 * without write permission can't have its entries removed, so `rm` fails
 * with EACCES. Symlinks are skipped, so nothing outside the folder changes.
 */
export async function makeTreeWritable(dirPath: string): Promise<void> {
  const st = await lstat(dirPath);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await chmod(dirPath, st.mode | 0o700);
    for (const name of await readdir(dirPath)) {
      await makeTreeWritable(path.join(dirPath, name)).catch(() => {});
    }
  } else if ((st.mode & 0o200) === 0) {
    await chmod(dirPath, st.mode | 0o200);
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * Deletes a directory with retry logic for Windows file locking issues
 *
 * On Windows, files can be locked by other processes (IDE, build tools, etc.)
 * which causes immediate deletion to fail. This function retries with linear
 * backoff to handle transient file locks.
 */
async function deleteDirectoryWithRetry(
  dirPath: string,
  maxRetries: number,
  retryDelay: number,
  logPrefix: string
): Promise<void> {
  let lastError: Error | null = null;
  let madeWritable = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return; // Success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isPermissionError(error) && !madeWritable) {
        // Read-only folders (e.g. a pnpm store): give the owner write access, then retry
        madeWritable = true;
        console.warn(`${logPrefix} Permission denied, making the folder writable before retrying`);
        await makeTreeWritable(dirPath).catch(() => {});
      }

      if (attempt < maxRetries) {
        const waitTime = retryDelay * attempt; // Linear backoff
        console.warn(
          `${logPrefix} Directory deletion attempt ${attempt}/${maxRetries} failed, ` +
          `retrying in ${waitTime}ms: ${lastError.message}`
        );
        await delay(waitTime);
      }
    }
  }

  // All retries exhausted - try shell rm -rf as fallback on Unix
  // Node's rm() can fail with ENOTEMPTY on macOS .app bundles
  if (process.platform !== 'win32') {
    try {
      console.warn(`${logPrefix} Node.js rm() failed, trying /bin/rm -rf fallback...`);
      execFileSync('/bin/rm', ['-rf', dirPath], { timeout: 60000 });
      return;
    } catch {
      // Fall through to throw original error
    }
  }

  throw lastError || new Error('Failed to delete directory after retries');
}

/**
 * Cleans up a worktree directory in a robust, cross-platform manner
 *
 * This function handles the Windows-specific issue where `git worktree remove --force`
 * fails when the worktree contains untracked files. The approach is:
 *
 * 1. Manually delete the directory with retry logic for file locks
 *    (falls back to shell `rm -rf` on Unix when Node.js rm() fails)
 * 2. Run `git worktree prune` to clean up git's internal references
 * 3. Optionally delete the associated branch
 *
 * All errors except directory deletion are logged but don't fail the operation.
 *
 * @param options - Cleanup configuration options
 * @returns Result object with success status and any warnings
 *
 * @example
 * ```typescript
 * const result = await cleanupWorktree({
 *   worktreePath: 'C:/projects/my-app/.vibe-teamlead/worktrees/tasks/001-feature',
 *   projectPath: 'C:/projects/my-app',
 *   specId: '001-feature',
 *   logPrefix: '[TASK_DELETE]'
 * });
 *
 * if (result.success) {
 *   console.log('Cleanup successful');
 * }
 * ```
 */
export async function cleanupWorktree(options: WorktreeCleanupOptions): Promise<WorktreeCleanupResult> {
  const {
    worktreePath,
    projectPath,
    specId,
    logPrefix = '[WORKTREE_CLEANUP]',
    deleteBranch = true,
    branchName,
    timeout = 30000,
    maxRetries = 3,
    retryDelay = 500,
    specsRelPath
  } = options;

  const warnings: string[] = [];
  // A Storybook started for this task's review must not keep files open in the folder
  stopStorybooksUnder(worktreePath);

  // Security: Validate that worktreePath is within the expected worktree directories
  // This prevents path traversal attacks and accidental deletion of wrong directories
  // Supports both task worktrees (.vibe-teamlead/worktrees/tasks) and terminal worktrees (.vibe-teamlead/worktrees/terminal)
  const taskBase = getTaskWorktreeDir(projectPath);
  const terminalBase = getTerminalWorktreeDir(projectPath);
  const isValidPath = isPathWithinBase(worktreePath, taskBase) || isPathWithinBase(worktreePath, terminalBase);

  if (!isValidPath) {
    console.error(`${logPrefix} Security: Path validation failed - worktree path is outside expected directories`);
    return {
      success: false,
      warnings: ['Invalid worktree path']
    };
  }

  // What agents started from this folder goes with it. Only after the check above: it removes things.
  await removeTaskContainers(worktreePath);
  // Its preview, if open, stops; its copy of the preview data goes with it
  await releaseTaskPreview(worktreePath);

  // 1. Get the branch name before we delete the directory
  const branch = getWorktreeBranch(worktreePath, specId, timeout, branchName);
  console.warn(`${logPrefix} Starting cleanup for worktree: ${worktreePath}`);
  if (branch) {
    console.warn(`${logPrefix} Associated branch: ${branch}`);
  }

  // 2. Keep the task's logs and reports (only task worktrees have a spec folder)
  if (specId && isPathWithinBase(worktreePath, taskBase) && existsSync(worktreePath)) {
    try {
      await preserveTaskSpec(worktreePath, projectPath, specId, specsRelPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`${logPrefix} Could not copy the task's spec folder back: ${msg}`);
      warnings.push(`Task logs and reports were not kept: ${msg}`);
    }
  }

  // 3. Delete the worktree directory manually
  // This is required because `git worktree remove --force` fails on Windows
  // when the directory contains untracked files (node_modules, build artifacts, etc.)
  if (existsSync(worktreePath)) {
    console.warn(`${logPrefix} Deleting worktree directory...`);
    try {
      await deleteDirectoryWithRetry(worktreePath, maxRetries, retryDelay, logPrefix);
      console.warn(`${logPrefix} Worktree directory deleted successfully`);
    } catch (deleteError) {
      // This IS critical - if we can't delete the directory, the cleanup failed
      const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
      console.error(`${logPrefix} Failed to delete worktree directory: ${msg}`);
      return {
        success: false,
        branch: branch || undefined,
        warnings: [...warnings, `Directory deletion failed: ${msg}`]
      };
    }
  } else {
    console.warn(`${logPrefix} Worktree directory already deleted`);
  }

  // 4. Prune git's internal worktree references
  // After manual deletion, git still thinks the worktree exists in .git/worktrees/
  // Running prune cleans up these stale references
  try {
    execFileSync(getToolPath('git'), ['worktree', 'prune'], {
      cwd: projectPath,
      encoding: 'utf-8',
      env: withoutGitHooks(getIsolatedGitEnv()),
      timeout
    });
    console.warn(`${logPrefix} Git worktree references pruned`);
  } catch (pruneError) {
    // Non-critical - the worktree is already gone, prune is just cleanup
    const msg = pruneError instanceof Error ? pruneError.message : String(pruneError);
    console.warn(`${logPrefix} Failed to prune worktree references (non-critical): ${msg}`);
    warnings.push(`Worktree prune failed: ${msg}`);
  }

  // 5. Delete the branch if requested
  // Only ever delete the task's own branch (or the one the caller named)
  const deletable = !!branch && (branch === branchName || isTaskBranch(branch));
  if (deleteBranch && branch && !deletable) {
    warnings.push(`Kept branch ${branch}: not a task branch`);
  }
  if (deleteBranch && branch && deletable) {
    try {
      execFileSync(getToolPath('git'), ['branch', '-D', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
        env: withoutGitHooks(getIsolatedGitEnv()),
        timeout
      });
      console.warn(`${logPrefix} Branch deleted: ${branch}`);
    } catch (branchError) {
      // Non-critical - branch might not exist or already deleted
      const msg = branchError instanceof Error ? branchError.message : String(branchError);
      console.warn(`${logPrefix} Failed to delete branch (non-critical): ${msg}`);
      warnings.push(`Branch deletion failed: ${msg}`);
    }
  }

  console.warn(`${logPrefix} Cleanup completed successfully`);
  return {
    success: true,
    branch: branch || undefined,
    warnings
  };
}
