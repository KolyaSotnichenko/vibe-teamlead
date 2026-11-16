import { isTaskBranch } from '../../../shared/constants/config';
import { appEvents } from '../../app-events';
import { ipcMain, BrowserWindow, app } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, DEFAULT_APP_SETTINGS, DEFAULT_FEATURE_MODELS, DEFAULT_FEATURE_THINKING, MODEL_ID_MAP, THINKING_BUDGET_MAP, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, WorktreeStatus, WorktreeDiff, WorktreeDiffFile, WorktreeMergeResult, WorktreeDiscardResult, WorktreeListResult, WorktreeListItem, WorktreeCreatePROptions, WorktreeCreatePRResult, SupportedIDE, SupportedTerminal, AppSettings } from '../../../shared/types';
import path from 'path';
import { minimatch } from 'minimatch';
import { existsSync, readdirSync, realpathSync, statSync, readFileSync, promises as fsPromises } from 'fs';
import { execFileSync, execFile } from 'child_process';
import { projectStore } from '../../project-store';

import { MergeOrchestrator } from '../../ai/merge/orchestrator';
import { runMergeIntegrator } from '../../ai/runners/merge-integrator';
import { describeVerification, projectVerification, verifyTask } from '../../ai/verification/verify-task';
import { createPR } from '../../ai/runners/github/pr-creator';
import type { ModelShorthand, ThinkingLevel } from '../../ai/config/types';
import { findTaskAndProject } from './shared';
import { updateRoadmapFeatureOutcome } from '../../utils/roadmap-utils';
import { getToolPath } from '../../cli-tool-manager';
import { promisify } from 'util';
import {
  getTaskWorktreeDir,
  findTaskWorktree,
} from '../../worktree-paths';
import { persistPlanStatus, updateTaskMetadataPrUrl } from './plan-file-utils';
import { getIsolatedGitEnv, refreshGitIndex } from '../../utils/git-isolation';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { detectInstalledTools, openInIDE, openInTerminal, type DetectedTools } from '../../services/dev-tools';
import { requestTaskBranchDelete } from '../../deploy/branch-push';
import { taskDiffBase } from '../../utils/task-diff-base';
import { excludeFromGit } from '../../utils/git-exclude';
import { cancelIntegrationReview, integrateAndMerge } from '../../ai/merge/integrate-task';
import { inMergeQueue, isMergeQueued } from '../../ai/merge/merge-queue';
import { approvedAsItIs, autoMergeRefusal, PREVIEW_HOLD } from '../../ai/orchestration/qa-approval';
import { changedFilesSinceBase, uiChangedSince } from '../../ai/orchestration/qa-browser-scope';
import { markWaitingForPreview } from './preview-hold';
import { taskStateManager } from '../../task-state-manager';
import { safeSendToRenderer } from '../utils';
import { getMainRunDeps, getReadiness } from '../../deploy/readiness-instance';
import { watchMainRuns } from '../../deploy/main-runs';
import { branchHead, pushMainAfterMerge } from '../../deploy/push-after-merge';
import { pushWithAppToken } from '../../deploy/github-write';
import type { MergeWorktreeOptions } from '../../../shared/types/task';
import { samePath } from '../../platform/same-path';

// Regex pattern for validating git branch names
export const GIT_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

/**
 * Validates a detected branch name and returns the safe branch to delete.
 *
 * Why the task branch prefix is considered safe:
 * - All task worktrees use branches named `vibe-teamlead/{specId}` (`auto-claude/{specId}`
 *   for tasks created before the rename and already pushed)
 * - This pattern is controlled by Vibe Teamlead, not user input
 * - If detected branch matches this pattern, it's a valid task branch
 * - If it doesn't match (e.g., `main`, `develop`, `feature/xxx`), it's likely
 *   the main project's branch being incorrectly detected from a corrupted worktree
 *
 * Issue #1479: When cleaning up a corrupted worktree, git rev-parse walks up
 * to the main project and returns its current branch instead of the worktree's branch.
 * This could cause deletion of the wrong branch.
 */
/**
 * True when `dir` is the root of its own git worktree (it has a `.git` entry and git
 * agrees that `dir` is the top level). A leftover folder inside the project is not.
 */
export function isOwnWorktree(dir: string): boolean {
  if (!existsSync(path.join(dir, '.git'))) return false;
  try {
    const top = execFileSync(getToolPath('git'), ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return samePath(realpathSync(top), realpathSync(dir));
  } catch {
    return false;
  }
}

export function validateWorktreeBranch(
  detectedBranch: string | null,
  expectedBranch: string
): { branchToDelete: string; usedFallback: boolean; reason: string } {
  // If detection failed, use expected pattern
  if (detectedBranch === null) {
    return {
      branchToDelete: expectedBranch,
      usedFallback: true,
      reason: 'detection_failed',
    };
  }

  // Exact match - ideal case
  if (detectedBranch === expectedBranch) {
    return {
      branchToDelete: detectedBranch,
      usedFallback: false,
      reason: 'exact_match',
    };
  }

  // Matches the task branch pattern with a valid specId (not just the prefix)
  // The specId must be non-empty for this to be a valid task branch
  if (isTaskBranch(detectedBranch)) {
    return {
      branchToDelete: detectedBranch,
      usedFallback: false,
      reason: 'pattern_match',
    };
  }

  // Detected branch doesn't match expected pattern - use fallback
  // This is the critical security fix for issue #1479
  return {
    branchToDelete: expectedBranch,
    usedFallback: true,
    reason: 'invalid_pattern',
  };
}

// Maximum PR title length (GitHub's limit is 256 characters)
const MAX_PR_TITLE_LENGTH = 256;

// Regex for validating PR title contains only printable characters
const PRINTABLE_CHARS_REGEX = /^[\x20-\x7E\u00A0-\uFFFF]*$/;

// Timeout for PR creation operations (2 minutes for network operations)
const PR_CREATION_TIMEOUT_MS = 120000;

/**
 * Read utility feature settings (for commit message, merge resolver) from settings file
 */
function getUtilitySettings(): { model: string; modelId: string; thinkingLevel: string; thinkingBudget: number | null } {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  try {
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, 'utf-8');
      const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...JSON.parse(content) };

      // Get utility-specific settings
      const featureModels = settings.featureModels || DEFAULT_FEATURE_MODELS;
      const featureThinking = settings.featureThinking || DEFAULT_FEATURE_THINKING;

      const model = featureModels.utility || DEFAULT_FEATURE_MODELS.utility;
      const thinkingLevel = featureThinking.utility || DEFAULT_FEATURE_THINKING.utility;

      return {
        model,
        modelId: MODEL_ID_MAP[model] || MODEL_ID_MAP.haiku,
        thinkingLevel,
        thinkingBudget: thinkingLevel in THINKING_BUDGET_MAP ? THINKING_BUDGET_MAP[thinkingLevel] : THINKING_BUDGET_MAP.low
      };
    }
  } catch (error) {
    // Log parse errors to help diagnose corrupted settings
    console.warn('[getUtilitySettings] Failed to parse settings.json:', error);
  }

  // Return defaults if settings file doesn't exist or fails to parse
  return {
    model: DEFAULT_FEATURE_MODELS.utility,
    modelId: MODEL_ID_MAP[DEFAULT_FEATURE_MODELS.utility],
    thinkingLevel: DEFAULT_FEATURE_THINKING.utility,
    thinkingBudget: THINKING_BUDGET_MAP[DEFAULT_FEATURE_THINKING.utility]
  };
}

const execFileAsync = promisify(execFile);

/**
 * Check if a repository is misconfigured as bare but has source files.
 * If so, automatically fix the configuration by unsetting core.bare.
 *
 * This can happen when git worktree operations incorrectly set bare=true,
 * or when users manually misconfigure the repository.
 *
 * @param projectPath - Path to check and potentially fix
 * @returns true if fixed, false if no fix needed or not fixable
 */
function fixMisconfiguredBareRepo(projectPath: string): boolean {
  try {
    // Check if bare=true is set
    const bareConfig = execFileSync(
      getToolPath('git'),
      ['config', '--get', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim().toLowerCase();

    if (bareConfig !== 'true') {
      return false; // Not marked as bare, nothing to fix
    }

    // Check if there are source files (indicating misconfiguration)
    // A truly bare repo would only have git internals, not source code
    // This covers multiple ecosystems: JS/TS, Python, Rust, Go, Java, C#, etc.
    //
    // Markers are separated into exact matches and glob patterns for efficiency.
    // Exact matches use existsSync() directly, while glob patterns use minimatch
    // against a cached directory listing.
    const EXACT_MARKERS = [
      // JavaScript/TypeScript ecosystem
      'package.json', 'apps', 'src',
      // Python ecosystem
      'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile',
      // Rust ecosystem
      'Cargo.toml',
      // Go ecosystem
      'go.mod', 'go.sum', 'cmd', 'main.go',
      // Java/JVM ecosystem
      'pom.xml', 'build.gradle', 'build.gradle.kts',
      // Ruby ecosystem
      'Gemfile', 'Rakefile',
      // PHP ecosystem
      'composer.json',
      // General project markers
      'Makefile', 'CMakeLists.txt', 'README.md', 'LICENSE'
    ];

    const GLOB_MARKERS = [
      // .NET/C# ecosystem - patterns that need glob matching
      '*.csproj', '*.sln', '*.fsproj'
    ];

    // Check exact matches first (fast path)
    const hasExactMatch = EXACT_MARKERS.some(marker =>
      existsSync(path.join(projectPath, marker))
    );

    if (hasExactMatch) {
      // Found a project marker, proceed to fix
    } else {
      // Check glob patterns - read directory once and cache for all patterns
      let directoryFiles: string[] | null = null;
      const MAX_FILES_TO_CHECK = 500; // Limit to avoid reading huge directories

      const hasGlobMatch = GLOB_MARKERS.some(pattern => {
        // Validate pattern - only support simple glob patterns for security
        if (pattern.includes('..') || pattern.includes('/')) {
          console.warn(`[GIT] Unsupported glob pattern ignored: ${pattern}`);
          return false;
        }

        // Lazy-load directory listing, cached across patterns
        if (directoryFiles === null) {
          try {
            const allFiles = readdirSync(projectPath);
            // Limit to first N entries to avoid performance issues
            directoryFiles = allFiles.slice(0, MAX_FILES_TO_CHECK);
            if (allFiles.length > MAX_FILES_TO_CHECK) {
              console.warn(`[GIT] Directory has ${allFiles.length} entries, checking only first ${MAX_FILES_TO_CHECK}`);
            }
          } catch (error) {
            // Log the error for debugging instead of silently swallowing
            console.warn(`[GIT] Failed to read directory ${projectPath}:`, error instanceof Error ? error.message : String(error));
            directoryFiles = [];
          }
        }

        // Use minimatch for proper glob pattern matching
        return directoryFiles.some(file => minimatch(file, pattern, { nocase: true }));
      });

      if (!hasGlobMatch) {
        return false; // Legitimately bare repo
      }
    }

    // Fix the misconfiguration
    console.warn('[GIT] Detected misconfigured bare repository with source files. Auto-fixing by unsetting core.bare...');
    execFileSync(
      getToolPath('git'),
      ['config', '--unset', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.warn('[GIT] Fixed: core.bare has been unset. Git operations should now work correctly.');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a valid git working tree (not a bare repository).
 * Returns true if the path is inside a git repository with a working tree.
 *
 * NOTE: This is a pure check with no side-effects. If you need to fix
 * misconfigured bare repos before an operation, call fixMisconfiguredBareRepo()
 * explicitly before calling this function.
 *
 * @param projectPath - Path to check
 * @returns true if it's a valid working tree, false if bare or not a git repo
 */
function isGitWorkTree(projectPath: string): boolean {
  try {
    // Use git rev-parse --is-inside-work-tree which returns "true" for working trees
    // and fails for bare repos or non-git directories
    const result = execFileSync(
      getToolPath('git'),
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim() === 'true';
  } catch {
    // Not a working tree (could be bare repo or not a git repo at all)
    return false;
  }
}

/**
 * Read the stored base branch from task_metadata.json
 * This is the branch the task was created from (set by user during task creation)
 */
function getTaskBaseBranch(specDir: string): string | undefined {
  // Defensive check for undefined input
  if (!specDir || typeof specDir !== 'string') {
    console.error('[getTaskBaseBranch] specDir is undefined or not a string');
    return undefined;
  }

  try {
    const metadataPath = path.join(specDir, 'task_metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      // Return baseBranch if explicitly set (not the __project_default__ marker)
      // Also validate it's a valid branch name to prevent malformed git commands
      if (metadata.baseBranch &&
          metadata.baseBranch !== '__project_default__' &&
          GIT_BRANCH_REGEX.test(metadata.baseBranch)) {
        // Strip remote prefix if present (e.g., "origin/feat/x" → "feat/x")
        const branch = metadata.baseBranch.replace(/^origin\//, '');
        return branch;
      }
    }
  } catch (e) {
    console.warn('[getTaskBaseBranch] Failed to read task metadata:', e);
  }
  return undefined;
}

/**
 * Get the effective base branch for a task with proper fallback chain.
 * Priority:
 * 1. Task metadata baseBranch (explicit task-level override from task_metadata.json)
 * 2. Project settings mainBranch (project-level default)
 * 3. Git default branch detection (main/master)
 * 4. Fallback to 'main'
 *
 * This should be used instead of getting the current HEAD branch,
 * as the user may be on a feature branch when viewing worktree status.
 */
function getEffectiveBaseBranch(projectPath: string, specId: string, projectMainBranch?: string): string {
  // Defensive check for undefined inputs
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[getEffectiveBaseBranch] projectPath is undefined or not a string');
    return 'main';
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[getEffectiveBaseBranch] specId is undefined or not a string');
    return 'main';
  }

  // 1. Try task metadata baseBranch
  const specDir = path.join(projectPath, '.vibe-teamlead', 'specs', specId);
  const taskBaseBranch = getTaskBaseBranch(specDir);
  if (taskBaseBranch) {
    return taskBaseBranch;
  }

  // 2. Try project settings mainBranch
  if (projectMainBranch && GIT_BRANCH_REGEX.test(projectMainBranch)) {
    return projectMainBranch;
  }

  // 3. Try to detect main/master branch
  for (const branch of ['main', 'master']) {
    try {
      execFileSync(getToolPath('git'), ['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // 4. Fallback to 'main'
  return 'main';
}

// ============================================
// Helper functions for TASK_WORKTREE_CREATE_PR
// ============================================

/**
 * Result of parsing JSON output from the create-pr Python script
 */
interface ParsedPRResult {
  success: boolean;
  prUrl?: string;
  alreadyExists?: boolean;
  error?: string;
}

/**
 * Validate that a URL is a valid GitHub PR URL.
 * Supports both github.com and GitHub Enterprise instances (custom domains).
 * Only requires HTTPS protocol and non-empty hostname to allow any GH Enterprise URL.
 * @returns true if the URL is a valid HTTPS URL with a non-empty hostname
 */
function isValidGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only require HTTPS with non-empty hostname
    // This supports GH Enterprise instances with custom domains
    // The URL comes from gh CLI output which we trust to be valid
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse JSON output from the create-pr Python script
 * Handles both snake_case and camelCase field names
 * @returns ParsedPRResult if valid JSON found, null otherwise
 */
function parsePRJsonOutput(stdout: string): ParsedPRResult | null {
  // Find the last complete JSON object in stdout (non-greedy, handles multiple objects)
  const jsonMatches = stdout.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  const jsonMatch = jsonMatches && jsonMatches.length > 0 ? jsonMatches[jsonMatches.length - 1] : null;

  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch);

    // Validate parsed JSON has expected shape
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    // Extract and validate fields with proper type checking
    // Handle both snake_case (from Python) and camelCase field names
    // Default success to false to avoid masking failures when field is missing
    const rawPrUrl = typeof parsed.pr_url === 'string' ? parsed.pr_url :
                     typeof parsed.prUrl === 'string' ? parsed.prUrl : undefined;

    // Validate PR URL is a valid GitHub URL for robustness
    const validatedPrUrl = rawPrUrl && isValidGitHubUrl(rawPrUrl) ? rawPrUrl : undefined;

    return {
      success: typeof parsed.success === 'boolean' ? parsed.success : false,
      prUrl: validatedPrUrl,
      alreadyExists: typeof parsed.already_exists === 'boolean' ? parsed.already_exists :
                     typeof parsed.alreadyExists === 'boolean' ? parsed.alreadyExists : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Result of updating task status after PR creation
 */
interface TaskStatusUpdateResult {
  mainProjectStatus: boolean;
  mainProjectMetadata: boolean;
  worktreeStatus: boolean;
  worktreeMetadata: boolean;
}

/**
 * Update task status and metadata after PR creation
 * Updates both main project and worktree locations
 * @returns Result object indicating which updates succeeded/failed
 */
async function updateTaskStatusAfterPRCreation(
  specDir: string,
  worktreePath: string | null,
  prUrl: string,
  autoBuildPath: string | undefined,
  specId: string,
  debug: (...args: unknown[]) => void
): Promise<TaskStatusUpdateResult> {
  const result: TaskStatusUpdateResult = {
    mainProjectStatus: false,
    mainProjectMetadata: false,
    worktreeStatus: false,
    worktreeMetadata: false
  };

  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  const metadataPath = path.join(specDir, 'task_metadata.json');

  // Await status persistence to ensure completion before resolving
  try {
    const persisted = await persistPlanStatus(planPath, 'done');
    result.mainProjectStatus = persisted;
    debug('Main project status persisted to done:', persisted);
  } catch (err) {
    debug('Failed to persist main project status:', err);
  }

  // Update metadata with prUrl in main project
  result.mainProjectMetadata = updateTaskMetadataPrUrl(metadataPath, prUrl);
  debug('Main project metadata updated with prUrl:', result.mainProjectMetadata);

  // Also persist to WORKTREE location (worktree takes priority when loading tasks)
  // This ensures the status persists after refresh since getTasks() prefers worktree version
  if (worktreePath) {
    const specsBaseDir = getSpecsDir(autoBuildPath);
    const worktreePlanPath = path.join(worktreePath, specsBaseDir, specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const worktreeMetadataPath = path.join(worktreePath, specsBaseDir, specId, 'task_metadata.json');

    try {
      const persisted = await persistPlanStatus(worktreePlanPath, 'done');
      result.worktreeStatus = persisted;
      debug('Worktree status persisted to done:', persisted);
    } catch (err) {
      debug('Failed to persist worktree status:', err);
    }

    result.worktreeMetadata = updateTaskMetadataPrUrl(worktreeMetadataPath, prUrl);
    debug('Worktree metadata updated with prUrl:', result.worktreeMetadata);
  }

  return result;
}

/**
 * Build arguments for the create-pr Python script
 */
function buildCreatePRArgs(
  runScript: string,
  specId: string,
  projectPath: string,
  options: WorktreeCreatePROptions | undefined,
  taskBaseBranch: string | undefined
): { args: string[]; validationError?: string } {
  const args = [
    runScript,
    '--spec', specId,
    '--project-dir', projectPath,
    '--create-pr'
  ];

  // Add optional arguments with validation
  if (options?.targetBranch) {
    // Validate branch name to prevent malformed git commands
    if (!GIT_BRANCH_REGEX.test(options.targetBranch)) {
      return { args: [], validationError: 'Invalid target branch name' };
    }
    args.push('--pr-target', options.targetBranch);
  }
  if (options?.title) {
    // Validate title for printable characters and length limit
    if (options.title.length > MAX_PR_TITLE_LENGTH) {
      return { args: [], validationError: `PR title exceeds maximum length of ${MAX_PR_TITLE_LENGTH} characters` };
    }
    if (!PRINTABLE_CHARS_REGEX.test(options.title)) {
      return { args: [], validationError: 'PR title contains invalid characters' };
    }
    args.push('--pr-title', options.title);
  }
  if (options?.draft) {
    args.push('--pr-draft');
  }

  // Add --base-branch if task was created with a specific base branch
  if (taskBaseBranch) {
    args.push('--base-branch', taskBaseBranch);
  }

  return { args };
}


/**
 * Generic retry wrapper with exponential backoff
 * @param operation - Async function to execute with retry
 * @param options - Retry configuration options
 * @returns Result of the operation or throws after all retries
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const { maxRetries: rawMaxRetries = 3, baseDelayMs = 100, onRetry, shouldRetry } = options;

  // Ensure at least one attempt is made (clamp to minimum of 1)
  const maxRetries = Math.max(1, rawMaxRetries);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      // Notify about retry
      onRetry?.(attempt, error);

      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('Retry loop exited unexpectedly');
}

/**
 * Register worktree management handlers
 */
export function registerWorktreeHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Get the worktree status for a task
   * Per-spec architecture: Each spec has its own worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_STATUS,
    async (_, taskId: string): Promise<IPCResult<WorktreeStatus>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return {
            success: true,
            data: { exists: false }
          };
        }

        // Get branch info from git
        try {
          // Get current branch in worktree
          const branch = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: worktreePath,
            encoding: 'utf-8'
          }).trim();

          // Get base branch using proper fallback chain:
          // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
          const baseBranch = getEffectiveBaseBranch(project.path, task.specId, project.settings?.mainBranch);

          // Get user's current branch in main project (this is where changes will merge INTO)
          let currentProjectBranch: string | undefined;
          try {
            currentProjectBranch = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: project.path,
              encoding: 'utf-8'
            }).trim();
          } catch {
            // Ignore - might be in detached HEAD or git error
          }

          // Get commit count (cross-platform - no shell syntax)
          let commitCount = 0;
          try {
            const countOutput = execFileSync(getToolPath('git'), ['rev-list', '--count', `${baseBranch}..HEAD`], {
              cwd: worktreePath,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            commitCount = parseInt(countOutput, 10) || 0;
          } catch {
            commitCount = 0;
          }

          // Get diff stats
          let filesChanged = 0;
          let additions = 0;
          let deletions = 0;

          // Use working-tree diff against baseBranch to capture ALL changes
          // (both committed and uncommitted). This ensures the UI shows file stats
          // even when the agent hasn't committed its work yet.
          try {
            const diffStat = execFileSync(getToolPath('git'), ['diff', '--stat', taskDiffBase(getToolPath('git'), worktreePath, baseBranch)], {
              cwd: worktreePath,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();

            // Parse the summary line (e.g., "3 files changed, 50 insertions(+), 10 deletions(-)")
            const summaryMatch = diffStat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
            if (summaryMatch) {
              filesChanged = parseInt(summaryMatch[1], 10) || 0;
              additions = parseInt(summaryMatch[2], 10) || 0;
              deletions = parseInt(summaryMatch[3], 10) || 0;
            }
          } catch {
            // Ignore diff errors
          }

          return {
            success: true,
            data: {
              exists: true,
              worktreePath,
              branch,
              baseBranch,
              currentProjectBranch,
              commitCount,
              filesChanged,
              additions,
              deletions
            }
          };
        } catch (gitError) {
          console.error('Git error getting worktree status:', gitError);
          return {
            success: true,
            data: { exists: true, worktreePath }
          };
        }
      } catch (error) {
        console.error('Failed to get worktree status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get worktree status'
        };
      }
    }
  );

  /**
   * Get the diff for a task's worktree
   * Per-spec architecture: Each spec has its own worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DIFF,
    async (_, taskId: string): Promise<IPCResult<WorktreeDiff>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return { success: false, error: 'No worktree found for this task' };
        }

        // Get base branch using proper fallback chain:
        // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
        // Note: We do NOT use current HEAD as that may be a feature branch
        const baseBranch = getEffectiveBaseBranch(project.path, task.specId, project.settings?.mainBranch);

        // Get the diff with file stats
        const files: WorktreeDiffFile[] = [];

        let numstat = '';
        let nameStatus = '';
        try {
          // Use working-tree diff against baseBranch to capture ALL changes
          // (both committed and uncommitted). This ensures the diff view shows
          // file changes even when the agent hasn't committed its work yet.
          const diffBase = taskDiffBase(getToolPath('git'), worktreePath, baseBranch);
          numstat = execFileSync(getToolPath('git'), ['diff', '--numstat', diffBase], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          // Get name-status for file status (cross-platform)
          nameStatus = execFileSync(getToolPath('git'), ['diff', '--name-status', diffBase], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          // Parse name-status to get file statuses
          const statusMap: Record<string, 'added' | 'modified' | 'deleted' | 'renamed'> = {};
          nameStatus.split('\n').filter(Boolean).forEach((line: string) => {
            const [status, ...pathParts] = line.split('\t');
            const filePath = pathParts.join('\t'); // Handle files with tabs in name
            switch (status[0]) {
              case 'A': statusMap[filePath] = 'added'; break;
              case 'M': statusMap[filePath] = 'modified'; break;
              case 'D': statusMap[filePath] = 'deleted'; break;
              case 'R': statusMap[pathParts[1] || filePath] = 'renamed'; break;
              default: statusMap[filePath] = 'modified';
            }
          });

          // Parse numstat for additions/deletions
          numstat.split('\n').filter(Boolean).forEach((line: string) => {
            const [adds, dels, filePath] = line.split('\t');
            files.push({
              path: filePath,
              status: statusMap[filePath] || 'modified',
              additions: parseInt(adds, 10) || 0,
              deletions: parseInt(dels, 10) || 0
            });
          });
        } catch (diffError) {
          console.error('Error getting diff:', diffError);
        }

        // Generate summary
        const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
        const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
        const summary = `${files.length} files changed, ${totalAdditions} insertions(+), ${totalDeletions} deletions(-)`;

        return {
          success: true,
          data: { files, summary }
        };
      } catch (error) {
        console.error('Failed to get worktree diff:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get worktree diff'
        };
      }
    }
  );

  /**
   * Merge the worktree changes into the main branch
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_MERGE,
    async (_, taskId: string, options?: MergeWorktreeOptions): Promise<IPCResult<WorktreeMergeResult>> => {
      const isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
      const debug = (...args: unknown[]) => {
        if (isDebugMode) {
          console.warn('[MERGE DEBUG]', ...args);
        }
      };

      try {
        debug('Handler called with taskId:', taskId, 'options:', options);

        // With a project, only in it: another project can have a task with the same number
        const { task, project } = findTaskAndProject(taskId, options?.projectId);
        if (!task || !project) {
          debug('Task or project not found');
          return { success: false, error: 'Task not found' };
        }

        debug('Found task:', task.specId, 'project:', project.path);

        const specDir = path.join(project.path, project.autoBuildPath || '.vibe-teamlead', 'specs', task.specId);
        const worktreePath = findTaskWorktree(project.path, task.specId);

        // Auto-fix any misconfigured bare repo before merge operation
        // This prevents issues where git operations fail due to incorrect bare=true config
        if (fixMisconfiguredBareRepo(project.path)) {
          debug('Fixed misconfigured bare repository at:', project.path);
        }

        // Determine base branch with proper priority:
        // 1. Task metadata baseBranch (explicit task-level override)
        // 2. Project settings mainBranch (project-level default)
        // 3. Default to 'main'
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const projectMainBranch = project.settings?.mainBranch;
        const effectiveBaseBranch = taskBaseBranch || projectMainBranch || 'main';
        debug('Using base branch:', effectiveBaseBranch,
          `(source: ${taskBaseBranch ? 'task metadata' : projectMainBranch ? 'project settings' : 'default'})`);

        // Get utility settings for merge resolver model selection
        const utilitySettings = getUtilitySettings();
        debug('Utility settings for merge:', utilitySettings);

        // Emit initial progress event so renderer shows the merge has started
        const mainWindow = getMainWindow();
        const emitProgress = (stage: string, percent: number, message: string, details: Record<string, unknown> = {}) => {
          if (mainWindow) {
            mainWindow.webContents.send(IPC_CHANNELS.TASK_MERGE_PROGRESS, taskId, {
              type: 'progress',
              stage,
              percent,
              message,
              details
            });
          }
        };

        // git does the merge. What it can't do, an agent does first, in the task's folder
        let mergeSucceeded = false;
        let mergeError: string | undefined;
        let conflictFiles: string[] | undefined;

        const git = { git: getToolPath('git'), env: getIsolatedGitEnv() };
        const taskBranch = { projectDir: project.path, branch: `vibe-teamlead/${task.specId}`, ...git };
        const mergeMessage = `Merge vibe-teamlead/${task.specId}: ${task.title}`;

        if (isMergeQueued(taskId)) {
          return { success: true, data: { success: false, message: 'This task is already merging, or waiting to.' } };
        }

        // "UI tasks wait for my preview": an approved task that changed UI stops here for the owner
        const touchesUi = project.settings?.previewBeforeAutoMerge && worktreePath
          ? () => uiChangedSince(() => changedFilesSinceBase(worktreePath))
          : undefined;
        const refusal = await autoMergeRefusal(options, worktreePath, task.specId, approvedAsItIs, touchesUi);
        if (refusal === PREVIEW_HOLD) {
          await markWaitingForPreview([path.join(specDir, 'implementation_plan.json'), ...(worktreePath ? [path.join(worktreePath, project.autoBuildPath || '.vibe-teamlead', 'specs', task.specId, 'implementation_plan.json')] : [])]);
          return { success: true, data: { success: false, message: refusal, heldForPreview: true } };
        }
        if (refusal) {
          return { success: true, data: { success: false, message: refusal } };
        }

        if (options?.reviewAction === 'cancel') {
          const cancelled = worktreePath ? await cancelIntegrationReview({ worktreePath, ...git }) : false;
          emitProgress('complete', 100, 'The merge was cancelled');
          return { success: true, data: { success: cancelled, message: cancelled ? 'The merge was cancelled.' : 'No merge is waiting for review, or the task could not be put back.' } };
        }

        const verification = projectVerification(project.path, project.settings);
        emitProgress('analyzing', 0, 'Starting the merge');

        const mergeResult = await inMergeQueue(project.path, taskId, () => integrateAndMerge({
          ...taskBranch,
          baseBranch: effectiveBaseBranch,
          worktreePath: worktreePath ?? undefined,
          uncommittedApproved: async () => (worktreePath ? approvedAsItIs(worktreePath, task.specId) : false),
          message: mergeMessage,
          stageOnly: options?.noCommit === true,
          confirmed: options?.reviewAction === 'commit',
          onProgress: (stage) => (stage === 'integrating'
            ? emitProgress('analyzing', 10, 'Bringing the latest changes into the task')
            : emitProgress('validating', 80, 'Merging into the project')),
          verify: verification
            ? async () => {
                if (!worktreePath) return { ok: true, summary: '' };
                emitProgress('validating', 70, 'The app is running the checks itself');
                const report = await verifyTask({ worktreePath, baseRef: effectiveBaseBranch, commands: verification.commands, env: verification.env, lockDir: verification.lockDir, git: git.git, hostEnv: git.env });
                const summary = describeVerification(report);
                if (report.status === 'regression') appEvents.emit('verification-regression', { taskId, projectId: project.id });
                return { ok: report.status !== 'regression', summary };
              }
            : undefined,
          runAgent: (request) => {
            emitProgress('resolving', 25, request.conflictFiles.length ? `An agent is resolving ${request.conflictFiles.length} conflict(s) and checking the result` : 'An agent is checking the result');
            return runMergeIntegrator({
              ...request,
              worktreePath: worktreePath ?? project.path,
              taskTitle: task.title,
              // Settings → Agents → Utility, not a fixed model
              model: utilitySettings.model,
              thinkingLevel: utilitySettings.thinkingLevel as ThinkingLevel,
              onEvent: (event) => {
                if (event.type === 'tool-call') emitProgress('resolving', 50, `Agent: ${event.toolName}`);
              },
            });
          },
        }), (ahead) => emitProgress('analyzing', 0, `Waiting for ${ahead} other merge(s) in this project`));
        debug('Merge result:', mergeResult);

        if (mergeResult.status === 'needs_review') {
          const count = mergeResult.files.length;
          emitProgress('complete', 100, 'Waiting for your review');
          return {
            success: true,
            data: {
              success: true,
              needsReview: true,
              conflictFiles: mergeResult.files,
              message: `An agent changed ${count} file(s) to bring in the latest changes. Nothing reached the project yet: open the task to check them and confirm.`,
            },
          };
        }

        if (mergeResult.status === 'conflicts') {
          conflictFiles = mergeResult.conflictFiles;
          mergeError = `Could not merge: ${(conflictFiles ?? []).join(', ')}. ${mergeResult.message ?? 'They are in conflict'}. Nothing was changed. Merge again.`;
        } else if (mergeResult.status === 'refused') {
          mergeError = mergeResult.message ?? 'Merge failed';
        } else {
          mergeSucceeded = true;
          emitProgress('complete', 100, 'Merge complete');
        }
        if (mergeError) emitProgress('error', 0, `Merge failed: ${mergeError}`);

        // Post-merge: check git status, update plan files, clean worktree

            // Get git status after merge (only if project is a working tree, not a bare repo)
            if (isGitWorkTree(project.path)) {
              try {
                const gitStatusAfter = execFileSync(getToolPath('git'), ['status', '--short'], { cwd: project.path, encoding: 'utf-8' });
                debug('Git status AFTER merge in main project:\n', gitStatusAfter || '(clean)');
                const gitDiffStaged = execFileSync(getToolPath('git'), ['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' });
                debug('Staged changes:\n', gitDiffStaged || '(none)');
              } catch (e) {
                debug('Failed to get git status after:', e);
              }
            } else {
              debug('Project is a bare repository - skipping git status check (this is normal for worktree-based projects)');
            }

            if (mergeSucceeded) {
              const isStageOnly = options?.noCommit === true;

              // Verify changes were actually staged when stage-only mode is requested
              // This prevents false positives when merge was already committed previously
              let hasActualStagedChanges = false;
              let mergeAlreadyCommitted = false;

              if (isStageOnly) {
                // Only check staged changes if project is a working tree (not bare repo)
                if (isGitWorkTree(project.path)) {
                  try {
                    const gitDiffStaged = execFileSync(getToolPath('git'), ['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' });
                    hasActualStagedChanges = gitDiffStaged.trim().length > 0;
                    debug('Stage-only verification: hasActualStagedChanges:', hasActualStagedChanges);

                    if (!hasActualStagedChanges) {
                      // Check if worktree branch was already merged (merge commit exists)
                      const specBranch = `vibe-teamlead/${task.specId}`;
                      try {
                        // Check if current branch contains all commits from spec branch
                        // git merge-base --is-ancestor returns exit code 0 if true, 1 if false
                        execFileSync(
                          getToolPath('git'),
                          ['merge-base', '--is-ancestor', specBranch, 'HEAD'],
                          { cwd: project.path, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
                        );
                        // If we reach here, the command succeeded (exit code 0) - branch is merged
                        mergeAlreadyCommitted = true;
                        debug('Merge already committed check:', mergeAlreadyCommitted);
                      } catch {
                        // Exit code 1 means not merged, or branch may not exist
                        mergeAlreadyCommitted = false;
                        debug('Could not check merge status, assuming not merged');
                      }
                    }
                  } catch (e) {
                    debug('Failed to verify staged changes:', e);
                  }
                } else {
                  // For bare repos, skip staging verification - merge happens in worktree
                  debug('Project is a bare repository - skipping staged changes verification');
                }
              }

              // Determine actual status based on verification
              let newStatus: string;
              let planStatus: string;
              let message: string;
              let staged: boolean;

              if (isStageOnly && !hasActualStagedChanges && mergeAlreadyCommitted) {
                // Stage-only was requested but merge was already committed previously
                // Keep in human_review and let user explicitly mark as done (which will trigger cleanup confirmation)
                // This ensures user is in control of when the worktree is deleted
                newStatus = 'human_review';
                planStatus = 'review';
                message = 'Changes were already merged and committed. You can mark this task as complete when ready.';
                staged = false;
                debug('Stage-only requested but merge already committed. Keeping in human_review for user to confirm completion.');
                // NOTE: We intentionally do NOT auto-clean the worktree here.
                // User can drag the task to "Done" column which will show a confirmation dialog
                // asking if they want to delete the worktree and mark complete.
              } else if (isStageOnly && !hasActualStagedChanges) {
                // Stage-only was requested but no changes to stage (and not committed)
                // This could mean nothing to merge or an error - keep in human_review for investigation
                newStatus = 'human_review';
                planStatus = 'review';
                message = 'No changes to stage. The worktree may have no differences from the current branch.';
                staged = false;
                debug('Stage-only requested but no changes to stage.');
              } else if (isStageOnly) {
                // Stage-only with actual staged changes - expected success case
                newStatus = 'human_review';
                planStatus = 'review';
                message = 'Changes staged in main project. Review with git status and commit when ready.';
                staged = true;
              } else {
                // Full merge (not stage-only)
                newStatus = 'done';
                planStatus = 'completed';
                message = 'Changes merged successfully';
                staged = false;
                appEvents.emit('task-merged', { taskId, projectId: project.id });

                // Deploy: send the new main to GitHub (fire and forget; never blocks or fails the merge)
                void pushMainAfterMerge(
                  project,
                  {
                    push: pushWithAppToken,
                    emit: (result) => { safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_PUSH_RESULT, result); },
                    headSha: branchHead,
                  },
                  effectiveBaseBranch,
                ).then((outcome) => {
                  // Deploy: follow the GitHub Actions runs of the pushed commit; a failed one becomes a fix task
                  const runDeps = getMainRunDeps();
                  if (outcome.pushed && outcome.sha && runDeps) {
                    try {
                      watchMainRuns(projectStore.getProject(project.id) ?? project, outcome.sha, runDeps);
                    } catch {
                      // informational
                    }
                  }
                }).catch(() => undefined);

                // Deploy: rescan readiness after a merge into main (never blocks or fails the merge)
                try {
                  const fresh = projectStore.getProject(project.id) ?? project;
                  void getReadiness()?.scan(fresh, 'merge', effectiveBaseBranch).catch(() => undefined);
                } catch {
                  // informational
                }

                // Clean up worktree after successful full merge (fixes #243)
                // This allows drag-to-Done workflow since TASK_UPDATE_STATUS blocks 'done' when worktree exists
                // Uses shared cleanup utility for robust Windows support (fixes #1539)
                if (worktreePath && existsSync(worktreePath)) {
                  const cleanupResult = await cleanupWorktree({
                    worktreePath,
                    projectPath: project.path,
                    specId: task.specId,
                    logPrefix: '[TASK_WORKTREE_MERGE]',
                    specsRelPath: getSpecsDir(project.autoBuildPath),
                    deleteBranch: true
                  });

                  if (cleanupResult.success) {
                    debug('Worktree cleaned up after full merge:', worktreePath);
                    if (cleanupResult.branch) {
                      debug('Task branch deleted:', cleanupResult.branch);
                    }
                  } else {
                    debug('Worktree cleanup failed (non-fatal):', cleanupResult.warnings);
                    // Non-fatal - merge succeeded; say so, so the leftover folder isn't a mystery
                    message = `Changes merged, but the task folder could not be removed (${cleanupResult.warnings[0] ?? 'unknown error'}). Delete it from Worktrees.`;
                  }

                  // Log any warnings for debugging
                  if (cleanupResult.warnings.length > 0) {
                    debug('Cleanup warnings:', cleanupResult.warnings);
                  }
                }

                // Its work is in the project now: the task's branch on GitHub goes too (never blocks or fails the merge)
                requestTaskBranchDelete(project, task);
              }

              debug('Merge result. isStageOnly:', isStageOnly, 'newStatus:', newStatus, 'staged:', staged);
              const reviewReason = newStatus === 'human_review' ? 'completed' : undefined;

              // Generate AI commit message if staging succeeded
              let suggestedCommitMessage: string | undefined;
              if (staged) {
                try {
                  // Get diff summary and changed files for context
                  let diffSummary = '';
                  let filesChangedList: string[] = [];

                  if (isGitWorkTree(project.path)) {
                    try {
                      const [diffResult, nameOnlyResult] = await Promise.all([
                        execFileAsync(getToolPath('git'), ['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' }),
                        execFileAsync(getToolPath('git'), ['diff', '--staged', '--name-only'], { cwd: project.path, encoding: 'utf-8' }),
                      ]);
                      diffSummary = diffResult.stdout.trim();
                      const nameOnly = nameOnlyResult.stdout.trim();
                      filesChangedList = nameOnly ? nameOnly.split('\n') : [];
                    } catch (e) {
                      debug('Failed to get staged diff for commit message:', e);
                    }
                  }

                  const { generateCommitMessage } = await import('../../ai/runners/commit-message');
                  // Settings → Agents → Utility, not a fixed model
                  const utility = getUtilitySettings();
                  suggestedCommitMessage = await generateCommitMessage({
                    projectDir: project.path,
                    specName: task.specId,
                    diffSummary,
                    filesChanged: filesChangedList,
                    modelShorthand: utility.model as ModelShorthand,
                    thinkingLevel: utility.thinkingLevel as ThinkingLevel,
                  });
                  debug('Generated commit message:', suggestedCommitMessage?.substring(0, 100));
                } catch (e) {
                  debug('Failed to generate commit message:', e);
                }
              }

              // Persist the status change to implementation_plan.json
              // Issue #243: We must update BOTH the main project's plan AND the worktree's plan (if it exists)
              // because ProjectStore prefers the worktree version when deduplicating tasks.
              // OPTIMIZATION: Use async I/O and parallel updates to prevent UI blocking
              // NOTE: The worktree has the same directory structure as main project
              const planPaths: { path: string; isMain: boolean }[] = [
                { path: path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), isMain: true },
              ];
              // Add worktree plan path if worktree exists
              if (worktreePath) {
                const worktreeSpecDir = path.join(worktreePath, project.autoBuildPath || '.vibe-teamlead', 'specs', task.specId);
                planPaths.push({ path: path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), isMain: false });
              }

              const { promises: fsPromises } = require('fs');

              // Update plan file with retry logic for transient failures
              // Uses EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
              const updatePlanWithRetry = async (planPath: string, isMain: boolean): Promise<boolean> => {
                // Helper to check if error is ENOENT (file not found)
                const isFileNotFound = (err: unknown): boolean =>
                  !!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');

                try {
                  await withRetry(
                    async () => {
                      const planContent = await fsPromises.readFile(planPath, 'utf-8');
                      const plan = JSON.parse(planContent);
                      plan.status = newStatus;
                      plan.planStatus = planStatus;
                      plan.reviewReason = reviewReason;
                      plan.updated_at = new Date().toISOString();
                      if (staged) {
                        plan.stagedAt = new Date().toISOString();
                        plan.stagedInMainProject = true;
                      }
                      await fsPromises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

                      // Verify the write succeeded by reading back
                      const verifyContent = await fsPromises.readFile(planPath, 'utf-8');
                      const verifyPlan = JSON.parse(verifyContent);
                      if (verifyPlan.status !== newStatus || verifyPlan.planStatus !== planStatus) {
                        throw new Error('Write verification failed - status mismatch');
                      }
                    },
                    {
                      maxRetries: 3,
                      baseDelayMs: 100,
                      shouldRetry: (err) => !isFileNotFound(err) // Don't retry if file doesn't exist
                    }
                  );
                  return true;
                } catch (err) {
                  // File doesn't exist - nothing to update (not an error)
                  if (isFileNotFound(err)) {
                    return true;
                  }
                  // Only log error if main plan fails; worktree plan might legitimately be missing or read-only
                  if (isMain) {
                    console.error('Failed to persist task status to main plan after retries:', err);
                  } else {
                    debug('Failed to persist task status to worktree plan (non-critical):', err);
                  }
                  return false;
                }
              };

              const updatePlans = async () => {
                const results = await Promise.all(
                  planPaths.map(({ path: planPath, isMain }) =>
                    updatePlanWithRetry(planPath, isMain)
                  )
                );
                // Log if main plan update failed (first element)
                if (!results[0]) {
                  console.warn('Background plan update: main plan write may not have persisted');
                }
              };

              // IMPORTANT: Wait for plan updates to complete before responding (fixes #243)
              // Previously this was "fire and forget" which caused a race condition:
              // resolve() would return before files were written, and UI refresh would read old status
              try {
                await updatePlans();
              } catch (err) {
                debug('Plan update failed:', err);
                // Non-fatal: UI will still update, but status may not persist across refresh
              }

              // Route status change through TaskStateManager (XState) to avoid dual emission
              taskStateManager.handleManualStatusChange(taskId, newStatus as any, task, project);

              return {
                success: true,
                data: {
                  success: true,
                  message,
                  staged,
                  projectPath: staged ? project.path : undefined,
                  suggestedCommitMessage
                }
              };
            } else {
              // Merge failed - return error to renderer
              debug('Merge failed. mergeError:', mergeError);
              return {
                success: true,
                data: {
                  success: false,
                  message: mergeError ?? 'Merge failed',
                  conflictFiles
                }
              };
            }
      } catch (error) {
        console.error('[MERGE] Exception in merge handler:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to merge worktree'
        };
      }
    }
  );

  /**
   * Preview merge conflicts before actually merging
   * Uses the TypeScript MergeOrchestrator to analyze potential conflicts without applying changes
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_MERGE_PREVIEW,
    async (_, taskId: string): Promise<IPCResult<WorktreeMergeResult>> => {
      console.warn('[IPC] TASK_WORKTREE_MERGE_PREVIEW called with taskId:', taskId);
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          console.error('[IPC] Task not found:', taskId);
          return { success: false, error: 'Task not found' };
        }
        console.warn('[IPC] Found task:', task.specId, 'project:', project.name);

        // Check for uncommitted changes in the main project (only if not a bare repo)
        let hasUncommittedChanges = false;
        let uncommittedFiles: string[] = [];
        if (isGitWorkTree(project.path)) {
          try {
            // The app's own folder is not the user's unfinished work
            excludeFromGit(project.path, `${project.autoBuildPath || '.vibe-teamlead'}/`);
            refreshGitIndex(project.path);

            const gitStatus = execFileSync(getToolPath('git'), ['status', '--porcelain'], {
              cwd: project.path,
              encoding: 'utf-8'
            });

            if (gitStatus?.trim()) {
              // Parse the status output to get file names
              // Format: XY filename (where X and Y are status chars, then space, then filename)
              uncommittedFiles = gitStatus
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.substring(3).trim()) // Skip 2 status chars + 1 space, trim any trailing whitespace
                .filter(file => file); // Remove empty strings from short/malformed status lines

              hasUncommittedChanges = uncommittedFiles.length > 0;
            }
          } catch (e) {
            console.error('[IPC] Failed to check git status:', e);
          }
        } else {
          console.warn('[IPC] Project is a bare repository - skipping uncommitted changes check');
        }

        // Determine base branch with proper priority:
        // 1. Task metadata baseBranch (explicit task-level override)
        // 2. Project settings mainBranch (project-level default)
        // 3. Default to 'main'
        const specDir = path.join(project.path, project.autoBuildPath || '.vibe-teamlead', 'specs', task.specId);
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const projectMainBranch = project.settings?.mainBranch;
        const effectiveBaseBranch = taskBaseBranch || projectMainBranch || 'main';
        console.warn('[IPC] Using base branch for preview:', effectiveBaseBranch,
          `(source: ${taskBaseBranch ? 'task metadata' : projectMainBranch ? 'project settings' : 'default'})`);

        // Run preview using the TypeScript MergeOrchestrator in dry-run mode
        // (no AI resolver needed for preview — only conflict detection and analysis)
        const storageDir = path.join(project.path, project.autoBuildPath || '.vibe-teamlead');
        const orchestrator = new MergeOrchestrator({
          projectDir: project.path,
          storageDir,
          enableAi: false,
          dryRun: true,
        });

        // Refresh evolution data from git before previewing.
        // previewMerge() only reads from the in-memory evolutions map (loaded from file_evolution.json).
        // Without refreshFromGit(), the map is stale/empty for tasks whose evolution wasn't previously tracked.
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          console.warn('[IPC] Refreshing evolution data from worktree:', worktreePath);
          orchestrator.evolutionTracker.refreshFromGit(task.specId, worktreePath, effectiveBaseBranch);
        } else {
          console.warn('[IPC] No worktree found for preview — evolution data may be stale');
        }

        console.warn('[IPC] Running TypeScript merge preview for task:', task.specId);
        const previewResult = orchestrator.previewMerge([task.specId]);

        const summary = previewResult['summary'] as Record<string, number> | undefined;
        const rawConflicts = previewResult['conflicts'] as Array<Record<string, unknown>> | undefined;
        const filesToMerge = previewResult['files_to_merge'] as string[] | undefined;

        // Map orchestrator conflict format to frontend MergeConflict shape
        const mergeConflicts = (rawConflicts || []).map((c) => ({
          file: String(c['file'] ?? ''),
          location: String(c['location'] ?? ''),
          tasks: Array.isArray(c['tasks']) ? (c['tasks'] as string[]) : [],
          severity: (c['severity'] ?? 'low') as import('../../../shared/types/task').ConflictSeverity,
          canAutoMerge: Boolean(c['can_auto_merge']),
          strategy: c['strategy'] != null ? String(c['strategy']) : undefined,
          reason: String(c['reason'] ?? ''),
        }));

        return {
          success: true,
          data: {
            success: true,
            message: 'Preview completed',
            preview: {
              files: filesToMerge || [],
              conflicts: mergeConflicts,
              summary: {
                totalFiles: summary?.['total_files'] ?? 0,
                conflictFiles: summary?.['conflict_files'] ?? 0,
                totalConflicts: summary?.['total_conflicts'] ?? 0,
                autoMergeable: summary?.['auto_mergeable'] ?? 0,
                hasGitConflicts: false,
              },
              // Include uncommitted changes info for the frontend
              uncommittedChanges: hasUncommittedChanges ? {
                hasChanges: true,
                files: uncommittedFiles,
                count: uncommittedFiles.length,
              } : null,
            },
          },
        };
      } catch (error) {
        console.error('[IPC] TASK_WORKTREE_MERGE_PREVIEW error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to preview merge'
        };
      }
    }
  );

  /**
   * Discard the worktree changes
   * Per-spec architecture: Each spec has its own worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
   *
   * Note: Uses the shared cleanupWorktree utility which handles Windows-specific issues
   * where `git worktree remove --force` fails when the directory contains untracked files.
   * See: upstream issue #1539
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DISCARD,
    async (_, taskId: string, skipStatusChange?: boolean): Promise<IPCResult<WorktreeDiscardResult>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return {
            success: true,
            data: {
              success: true,
              message: 'No worktree to discard'
            }
          };
        }

        // Use the shared cleanup utility for robust, cross-platform worktree deletion
        const cleanupResult = await cleanupWorktree({
          worktreePath,
          projectPath: project.path,
          specId: task.specId,
          logPrefix: '[TASK_WORKTREE_DISCARD]',
          specsRelPath: getSpecsDir(project.autoBuildPath),
          deleteBranch: true
        });

        if (!cleanupResult.success) {
          console.error('[TASK_WORKTREE_DISCARD] Cleanup failed:', cleanupResult.warnings);
          return {
            success: false,
            error: `Failed to discard worktree: ${cleanupResult.warnings.join('; ')}`
          };
        }

        // Log any non-fatal warnings
        if (cleanupResult.warnings.length > 0) {
          console.warn('[TASK_WORKTREE_DISCARD] Cleanup warnings:', cleanupResult.warnings);
        }


        // The discarded work must not stay on GitHub either (and a later run starts the branch anew)
        requestTaskBranchDelete(project, task);

        // Only send status change to backlog if not skipped
        // (skip when caller will set a different status, e.g., 'done')
        if (!skipStatusChange) {
          // Route through TaskStateManager (XState) to avoid dual emission
          taskStateManager.handleManualStatusChange(taskId, 'backlog', task, project);
        }

        return {
          success: true,
          data: {
            success: true,
            message: 'Worktree discarded successfully'
          }
        };
      } catch (error) {
        console.error('Failed to discard worktree:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to discard worktree'
        };
      }
    }
  );

  // Promisified execFile for async git operations
  const execFileAsync = promisify(execFile);

  /**
   * Discard an orphaned worktree by spec name (no task association required)
   * Used when the worktree exists but the task is missing or git state is corrupted
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN,
    async (_, projectId: string, specName: string): Promise<IPCResult<WorktreeDiscardResult>> => {
      try {
        // Validate inputs
        if (!projectId || typeof projectId !== 'string') {
          console.error('discardOrphanedWorktree: Invalid projectId:', projectId);
          return { success: false, error: 'Invalid projectId' };
        }
        if (!specName || typeof specName !== 'string') {
          console.error('discardOrphanedWorktree: Invalid specName:', specName);
          return { success: false, error: 'Invalid specName' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Validate project.path
        if (!project.path || typeof project.path !== 'string') {
          console.error('discardOrphanedWorktree: Project path is invalid:', project.path);
          return { success: false, error: 'Project path is invalid' };
        }

        // Find worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, specName);

        if (!worktreePath) {
          return {
            success: true,
            data: {
              success: true,
              message: 'No worktree to discard'
            }
          };
        }

        // Use cleanupWorktree for robust, cross-platform worktree deletion
        const cleanupResult = await cleanupWorktree({
          worktreePath,
          projectPath: project.path,
          specId: specName,
          logPrefix: '[ORPHAN_CLEANUP]',
          deleteBranch: true
        });

        if (!cleanupResult.success) {
          return {
            success: false,
            error: cleanupResult.warnings.join(', ') || 'Failed to cleanup orphaned worktree'
          };
        }

        return {
          success: true,
          data: {
            success: true,
            message: 'Orphaned worktree deleted successfully'
          }
        };
      } catch (error) {
        console.error('Failed to discard orphaned worktree:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to discard orphaned worktree'
        };
      }
    }
  );

  /**
   * List all spec worktrees for a project
   * Per-spec architecture: Each spec has its own worktree at .vibe-teamlead/worktrees/tasks/{spec-name}/
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST_WORKTREES,
    async (_, projectId: string): Promise<IPCResult<WorktreeListResult>> => {
      try {
        // Validate projectId
        if (!projectId || typeof projectId !== 'string') {
          console.error('listWorktrees: Invalid projectId:', projectId);
          return { success: false, error: 'Invalid projectId' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

// Validate project.path
        if (!project.path || typeof project.path !== 'string') {
          console.error('listWorktrees: Project path is invalid:', project.path);
          return { success: false, error: 'Project path is invalid' };
        }

        const worktreesDir = getTaskWorktreeDir(project.path);

        // Fetch tasks once before iterating (avoids repeated lookups per entry)
        // Used for orphan detection - worktrees without a matching task are orphaned
        const tasks = projectStore.getTasks(projectId);
        // Track if task lookup was successful (empty array with existing specs dir = lookup failed)
        const mainSpecsDir = path.join(project.path, '.vibe-teamlead', 'specs');
        const taskLookupSuccessful = tasks.length > 0 || !existsSync(mainSpecsDir);

        // Helper to process a single worktree entry (async)
        const processWorktreeEntry = async (entry: string, entryPath: string): Promise<WorktreeListItem | null> => {
          try {
            // A folder left behind by a cleanup that only half worked is no longer a
            // worktree: git walks up to the project and would report its branch (main).
            // Show it as a leftover to delete, never as a task branch to merge.
            if (!isOwnWorktree(entryPath)) {
              return {
                specName: entry,
                path: entryPath,
                branch: '',
                baseBranch: '',
                commitCount: 0,
                filesChanged: 0,
                additions: 0,
                deletions: 0,
                isOrphaned: true
              };
            }

            // Get branch info (async)
            const branchResult = await execFileAsync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: entryPath,
              encoding: 'utf-8'
            });
            const branch = (branchResult.stdout as string).trim();

            // Get base branch using proper fallback chain:
            // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
            // Note: We do NOT use current HEAD as that may be a feature branch
            const baseBranch = getEffectiveBaseBranch(project.path, entry, project.settings?.mainBranch);

// Get commit count (async, cross-platform - no shell syntax)
            let commitCount = 0;
            try {
              const countResult = await execFileAsync(getToolPath('git'), ['rev-list', '--count', `${baseBranch}..HEAD`], {
                cwd: entryPath,
                encoding: 'utf-8'
              });
              commitCount = parseInt((countResult.stdout as string).trim(), 10) || 0;
            } catch {
              commitCount = 0;
            }

            // Get diff stats (async, cross-platform - no shell syntax)
            let filesChanged = 0;
            let additions = 0;
            let deletions = 0;

            try {
              const diffResult = await execFileAsync(getToolPath('git'), ['diff', '--shortstat', `${baseBranch}...HEAD`], {
                cwd: entryPath,
                encoding: 'utf-8'
              });
              const diffStat = (diffResult.stdout as string).trim();

              const filesMatch = diffStat.match(/(\d+) files? changed/);
              const addMatch = diffStat.match(/(\d+) insertions?/);
              const delMatch = diffStat.match(/(\d+) deletions?/);

              if (filesMatch) filesChanged = parseInt(filesMatch[1], 10) || 0;
              if (addMatch) additions = parseInt(addMatch[1], 10) || 0;
              if (delMatch) deletions = parseInt(delMatch[1], 10) || 0;
            } catch {
              // Ignore diff errors
            }

            // Check if there's a task associated with this worktree
            // A worktree without a task is considered orphaned (can happen if task was deleted)
            // Only mark as orphaned if task lookup was successful (avoid false positives)
            const hasTask = tasks.some(t => t.specId === entry);

            return {
              specName: entry,
              path: entryPath,
              branch,
              baseBranch,
              commitCount,
              filesChanged,
              additions,
              deletions,
              isOrphaned: taskLookupSuccessful ? !hasTask : false
            };
          } catch (gitError) {
            // FIX: Don't skip worktree if git fails - it may be orphaned/corrupted
            // Include it so it can be managed (deleted if orphaned)
            const hasTask = tasks.some(t => t.specId === entry);
            console.warn(`[Worktree] Git commands failed for ${entry}, hasTask=${hasTask}:`, gitError);
            // Note: branch is empty - renderer should handle based on isOrphaned flag
            return {
              specName: entry,
              path: entryPath,
              branch: '',
              baseBranch: '',
              commitCount: 0,
              filesChanged: 0,
              additions: 0,
              deletions: 0,
              isOrphaned: taskLookupSuccessful ? !hasTask : false
            };
          }
        };

        // Scan worktrees directory (async)
        if (!existsSync(worktreesDir)) {
          return { success: true, data: { worktrees: [] } };
        }

        const entries = await fsPromises.readdir(worktreesDir);

        // Process all worktrees in parallel for better performance
        const worktreePromises = entries.map(async (entry) => {
          const entryPath = path.join(worktreesDir, entry);
          try {
            const stat = await fsPromises.stat(entryPath);
            if (stat.isDirectory()) {
              return processWorktreeEntry(entry, entryPath);
            }
          } catch {
            // Skip entries that can't be stat'd
          }
          return null;
        });

        const results = await Promise.all(worktreePromises);
        const worktrees = results.filter((w): w is WorktreeListItem => w !== null);

        return { success: true, data: { worktrees } };
      } catch (error) {
        console.error('Failed to list worktrees:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list worktrees'
        };
      }
    }
  );

  /**
   * Detect installed IDEs and terminals on the system
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS,
    async (): Promise<IPCResult<DetectedTools>> => {
      try {
        const tools = await detectInstalledTools();
        return { success: true, data: tools };
      } catch (error) {
        console.error('Failed to detect tools:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to detect installed tools'
        };
      }
    }
  );

  /**
   * Open a worktree directory in the specified IDE
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE,
    async (_, worktreePath: string, ide: SupportedIDE, customPath?: string): Promise<IPCResult<{ opened: boolean }>> => {
      try {
        if (!existsSync(worktreePath)) {
          return { success: false, error: 'Worktree path does not exist' };
        }

        const result = await openInIDE(worktreePath, ide, customPath);
        if (!result.success) {
          return { success: false, error: result.error };
        }

        return { success: true, data: { opened: true } };
      } catch (error) {
        console.error('Failed to open in IDE:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open in IDE'
        };
      }
    }
  );

  /**
   * Open a worktree directory in the specified terminal
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL,
    async (_, worktreePath: string, terminal: SupportedTerminal, customPath?: string): Promise<IPCResult<{ opened: boolean }>> => {
      try {
        if (!existsSync(worktreePath)) {
          return { success: false, error: 'Worktree path does not exist' };
        }

        const result = await openInTerminal(worktreePath, terminal, customPath);
        if (!result.success) {
          return { success: false, error: result.error };
        }

        return { success: true, data: { opened: true } };
      } catch (error) {
        console.error('Failed to open in terminal:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open in terminal'
        };
      }
    }
  );

  /**
   * Clear the staged state for a task
   * This allows the user to re-stage changes if needed
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CLEAR_STAGED_STATE,
    async (_, taskId: string): Promise<IPCResult<{ cleared: boolean }>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const specDir = path.join(project.path, specsBaseDir, task.specId);
        const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

        // Use EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
        const { promises: fsPromises } = require('fs');
        const isFileNotFound = (err: unknown): boolean =>
          !!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');

        // Read, update, and write the plan file
        let planContent: string;
        try {
          planContent = await fsPromises.readFile(planPath, 'utf-8');
        } catch (readErr) {
          if (isFileNotFound(readErr)) {
            return { success: false, error: 'Implementation plan not found' };
          }
          throw readErr;
        }

        const plan = JSON.parse(planContent);

        // Clear the staged state flags
        delete plan.stagedInMainProject;
        delete plan.stagedAt;
        plan.updated_at = new Date().toISOString();

        await fsPromises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

        // Also update worktree plan if it exists
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          const worktreePlanPath = path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
          try {
            const worktreePlanContent = await fsPromises.readFile(worktreePlanPath, 'utf-8');
            const worktreePlan = JSON.parse(worktreePlanContent);
            delete worktreePlan.stagedInMainProject;
            delete worktreePlan.stagedAt;
            worktreePlan.updated_at = new Date().toISOString();
            await fsPromises.writeFile(worktreePlanPath, JSON.stringify(worktreePlan, null, 2), 'utf-8');
          } catch (e) {
            // Non-fatal - worktree plan update is best-effort
            // ENOENT is expected when worktree has no plan file
            if (!isFileNotFound(e)) {
              console.warn('[CLEAR_STAGED_STATE] Failed to update worktree plan:', e);
            }
          }
        }

        // Invalidate tasks cache to force reload
        projectStore.invalidateTasksCache(project.id);

        return { success: true, data: { cleared: true } };
      } catch (error) {
        console.error('Failed to clear staged state:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear staged state'
        };
      }
    }
  );

  /**
   * Create a Pull Request from the worktree branch
   * Pushes the branch to origin and creates a GitHub PR using gh CLI
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_CREATE_PR,
    async (_, taskId: string, options?: WorktreeCreatePROptions): Promise<IPCResult<WorktreeCreatePRResult>> => {
      const isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
      const debug = (...args: unknown[]) => {
        if (isDebugMode) {
          console.warn('[CREATE_PR DEBUG]', ...args);
        }
      };

      try {
        debug('Handler called with taskId:', taskId, 'options:', options);

        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          debug('Task or project not found');
          return { success: false, error: 'Task not found' };
        }

        debug('Found task:', task.specId, 'project:', project.path);

        const specDir = path.join(project.path, project.autoBuildPath || '.vibe-teamlead', 'specs', task.specId);

        // Use EAFP pattern - try to read specDir and catch ENOENT
        try {
          statSync(specDir);
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
            debug('Spec directory not found:', specDir);
            return { success: false, error: 'Spec directory not found' };
          }
          throw err; // Re-throw unexpected errors
        }

        // Check worktree exists before creating PR
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (!worktreePath) {
          debug('No worktree found for spec:', task.specId);
          return { success: false, error: 'No worktree found for this task' };
        }
        debug('Worktree path:', worktreePath);

        // Validate options
        if (options?.targetBranch && !GIT_BRANCH_REGEX.test(options.targetBranch)) {
          return { success: false, error: 'Invalid target branch name' };
        }
        if (options?.title) {
          if (options.title.length > MAX_PR_TITLE_LENGTH) {
            return { success: false, error: `PR title exceeds maximum length of ${MAX_PR_TITLE_LENGTH} characters` };
          }
          if (!PRINTABLE_CHARS_REGEX.test(options.title)) {
            return { success: false, error: 'PR title contains invalid characters' };
          }
        }

        // Determine base branch and branch name
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const baseBranch = options?.targetBranch || taskBaseBranch || 'main';
        const branchName = `vibe-teamlead/${task.specId}`;
        const prTitle = options?.title || `vibe-teamlead: ${task.specId}`;

        if (taskBaseBranch) {
          debug('Using stored base branch:', taskBaseBranch);
        }

        // Get tool paths
        const ghPath = getToolPath('gh');
        const gitPath = getToolPath('git');

        debug('Creating PR via TypeScript runner:', { branchName, baseBranch, prTitle });

        // Run the TypeScript PR creator
        const result = await createPR({
          projectDir: project.path,
          worktreePath,
          specId: task.specId,
          branchName,
          baseBranch,
          title: prTitle,
          draft: options?.draft,
          ghPath,
          gitPath,
          // The PR description is written by the Utility model (Settings → Agents)
          modelShorthand: getUtilitySettings().model as ModelShorthand,
          thinkingLevel: getUtilitySettings().thinkingLevel as ThinkingLevel,
        });

        debug('PR creation result:', result);

        if (result.success && result.prUrl && !result.alreadyExists) {
          // Update task status after successful PR creation
          await updateTaskStatusAfterPRCreation(
            specDir,
            worktreePath,
            result.prUrl,
            project.autoBuildPath,
            task.specId,
            debug
          );

          // Update linked roadmap feature
          if (project.path && task.specId) {
            const roadmapFile = path.join(project.path, AUTO_BUILD_PATHS.ROADMAP_DIR, AUTO_BUILD_PATHS.ROADMAP_FILE);
            updateRoadmapFeatureOutcome(roadmapFile, [task.specId], 'completed', '[PR_CREATE]').catch((err) => {
              debug('Failed to update roadmap feature after PR creation:', err);
            });
          }
        } else if (result.alreadyExists) {
          debug('PR already exists, not updating task status');
        }

        if (result.success) {
          return {
            success: true,
            data: {
              success: true,
              prUrl: result.prUrl,
              alreadyExists: result.alreadyExists
            }
          };
        }

        return {
          success: false,
          error: result.error || 'Failed to create PR'
        };
      } catch (error) {
        console.error('[CREATE_PR] Exception in handler:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create PR'
        };
      }
    }
  );
}
