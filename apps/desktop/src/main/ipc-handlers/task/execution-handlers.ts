import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, ImageAttachment } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { getToolPath } from '../../cli-tool-manager';
import { requestQaRerun } from '../../ai/orchestration/qa-rerun';
import { getIntegrationReview } from '../../ai/merge/integrate-task';
import { isMergeQueued } from '../../ai/merge/merge-queue';
import { AgentManager } from '../../agent';
import { fileWatcher } from '../../file-watcher';
import { findTaskAndProject } from './shared';
import { returnStaleQueuedTask, STALE_QUEUED_TASK_MESSAGE } from './queue-task';
import { watchAndStartAgent } from './start-agent';
import { requestTaskBranchDelete } from '../../deploy/branch-push';
import { checkGitStatus } from '../../project-initializer';
import { resolveClaudeCredential } from '../../ai/claude-code/credential';
import { taskStateManager } from '../../task-state-manager';
import {
  getPlanPath,
  persistPlanStatus,
  createPlanIfNotExists,
  resetStuckSubtasks,
  hasPlanWithSubtasks
} from './plan-file-utils';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { findTaskWorktree } from '../../worktree-paths';
import { markWaitingForPreview } from './preview-hold';
import { applyFailedSubtaskDecision, parseFailedSubtaskDecision, taskOwnerDecisionsFile } from './failed-subtask-decision';
import { projectStore } from '../../project-store';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { cancelFallbackTimer } from '../agent-events-handlers';
import { handleBaseFailures } from './base-fix-handler';
import { createTaskInProject } from './crud-handlers';
import { resolveDefaultTaskModels } from '../../../shared/utils/task-models';
import { readSettingsFile } from '../../settings-utils';
import { debugLog } from '../../../shared/utils/debug-logger';
import { queuePause, stopTaskLikeStop } from './task-control';

/** Whether the app's Claude credential (API key or personal-mode token) is available */
function hasClaudeCredential(): boolean {
  return !!resolveClaudeCredential().key;
}

const MISSING_CREDENTIAL_MESSAGE = 'No Claude credentials configured. Add an Anthropic API key or a Claude subscription token in Settings > Claude before starting tasks.';

/**
 * Safe file read that handles missing files without TOCTOU issues.
 * Returns null if file doesn't exist or can't be read.
 */
function safeReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    // ENOENT (file not found) is expected, other errors should be logged
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[safeReadFileSync] Error reading ${filePath}:`, error);
    }
    return null;
  }
}

/**
 * Helper function to check subtask completion status
 */
function checkSubtasksCompletion(plan: Record<string, unknown> | null): {
  allSubtasks: Array<{ status: string }>;
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
} {
  const allSubtasks = (plan?.phases as Array<{ subtasks?: Array<{ status: string }> }> | undefined)?.flatMap(phase =>
    phase.subtasks || []
  ) || [];
  const completedCount = allSubtasks.filter(s => s.status === 'completed').length;
  const totalCount = allSubtasks.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;

  return { allSubtasks, completedCount, totalCount, allCompleted };
}

/**
 * Start a task: from the board (TASK_START), or from the app itself (a task that fixes main).
 * Starting here doesn't look at the queue: the renderer decides what waits.
 */
export async function startTask(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null, taskId: string): Promise<void> {
  console.warn('[TASK_START] Received request for taskId:', taskId);

  // Cancel any pending fallback timer from previous process exit
  // This prevents the stale timer from incorrectly stopping the newly restarted task
  cancelFallbackTimer(taskId);

  const mainWindow = getMainWindow();
  if (!mainWindow) {
    console.warn('[TASK_START] No main window found');
    return;
  }

  // Find task and project
  // First search all projects to find the task, then verify the project matches
  // task.projectId to prevent cross-project contamination when multiple projects
  // have tasks with overlapping specIds (e.g., after delete/recreate).
  const { task, project: foundProject } = findTaskAndProject(taskId);

  if (!task || !foundProject) {
    console.warn('[TASK_START] Task or project not found for taskId:', taskId);
    mainWindow.webContents.send(
      IPC_CHANNELS.TASK_ERROR,
      taskId,
      'Task or project not found'
    );
    return;
  }

  // Use task's own projectId as the authoritative source (prevents wrong-project execution)
  const project = (task.projectId && task.projectId !== foundProject.id)
    ? (projectStore.getProject(task.projectId) ?? foundProject)
    : foundProject;

  // Check git status - Vibe Teamlead requires git for worktree-based builds
  const gitStatus = checkGitStatus(project.path);
  if (!gitStatus.isGitRepo) {
    console.warn('[TASK_START] Project is not a git repository:', project.path);
    mainWindow.webContents.send(
      IPC_CHANNELS.TASK_ERROR,
      taskId,
      'Git repository required. Please run "git init" in your project directory. Vibe Teamlead uses git worktrees for isolated builds.'
    );
    return;
  }
  if (!gitStatus.hasCommits) {
    console.warn('[TASK_START] Git repository has no commits:', project.path);
    mainWindow.webContents.send(
      IPC_CHANNELS.TASK_ERROR,
      taskId,
      'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").'
    );
    return;
  }

  // Check the Claude credential
  if (!hasClaudeCredential()) {
    console.warn('[TASK_START] No Claude credential configured');
    mainWindow.webContents.send(
      IPC_CHANNELS.TASK_ERROR,
      taskId,
      MISSING_CREDENTIAL_MESSAGE
    );
    return;
  }

  console.warn('[TASK_START] Found task:', task.specId, 'status:', task.status, 'reviewReason:', task.reviewReason, 'subtasks:', task.subtasks.length);

  // Clear stale tracking state from any previous execution so that:
  // - terminalEventSeen doesn't suppress future PROCESS_EXITED events
  // - lastSequenceByTask doesn't drop events from the new process
  taskStateManager.prepareForRestart(taskId);

  // Check if implementation_plan.json has valid subtasks BEFORE XState handling.
  // This is more reliable than task.subtasks.length which may not be loaded yet.
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(
    project.path,
    specsBaseDir,
    task.specId
  );
  const planFilePath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  let planHasSubtasks = false;
  const planContent = safeReadFileSync(planFilePath);
  if (planContent) {
    try {
      const plan = JSON.parse(planContent);
      planHasSubtasks = checkSubtasksCompletion(plan).totalCount > 0;
    } catch {
      // Invalid/corrupt plan file - treat as no subtasks
    }
  }

  // Immediately mark as started so the UI moves the card to In Progress.
  // Use XState actor state as source of truth (if actor exists), with task data as fallback.
  // - plan_review: User approved the plan, send PLAN_APPROVED to transition to coding
  // - human_review/error: User resuming, send USER_RESUMED
  // - backlog/other: Fresh start, send PLANNING_STARTED
  const currentXState = taskStateManager.getCurrentState(taskId);
  console.warn('[TASK_START] Current XState:', currentXState, '| Task status:', task.status, task.reviewReason);

  if (currentXState === 'design_review' || (!currentXState && task.status === 'human_review' && task.reviewReason === 'design_review')) {
    // Design before code: the owner approved or commented; the build goes on (or redraws)
    taskStateManager.handleUiEvent(taskId, { type: 'DESIGN_RESUMED' }, task, project);
  } else if (currentXState === 'plan_review') {
    // XState says plan_review - send PLAN_APPROVED
    console.warn('[TASK_START] XState: plan_review -> coding via PLAN_APPROVED');
    taskStateManager.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
  } else if (currentXState === 'error' && !planHasSubtasks) {
    // FIX (#1562): Task crashed during planning (no subtasks yet).
    // Uses planHasSubtasks from implementation_plan.json (more reliable than task.subtasks.length).
    console.warn('[TASK_START] XState: error with no plan subtasks -> planning via PLANNING_STARTED');
    taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
  } else if (currentXState === 'human_review' || currentXState === 'error') {
    // XState says human_review or error - send USER_RESUMED
    console.warn('[TASK_START] XState:', currentXState, '-> coding via USER_RESUMED');
    taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
  } else if (currentXState) {
    // XState actor exists but in another state (coding, planning, etc.)
    // This shouldn't happen normally, but handle gracefully
    console.warn('[TASK_START] XState in unexpected state:', currentXState, '- sending PLANNING_STARTED');
    taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
  } else if (task.status === 'human_review' && task.reviewReason === 'plan_review') {
    // No XState actor - fallback to task data (e.g., after app restart)
    console.warn('[TASK_START] No XState actor, task data: plan_review -> coding via PLAN_APPROVED');
    taskStateManager.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
  } else if (task.status === 'error' && !planHasSubtasks) {
    // FIX (#1562): No XState actor, task crashed during planning (no subtasks).
    // Uses planHasSubtasks from implementation_plan.json (more reliable than task.subtasks.length).
    console.warn('[TASK_START] No XState actor, error with no plan subtasks -> planning via PLANNING_STARTED');
    taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
  } else if (task.status === 'human_review' || task.status === 'error') {
    // No XState actor - fallback to task data for resuming
    console.warn('[TASK_START] No XState actor, task data:', task.status, '-> coding via USER_RESUMED');
    taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
  } else {
    // Fresh start - PLANNING_STARTED transitions from backlog to planning
    console.warn('[TASK_START] Fresh start via PLANNING_STARTED');
    taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
  }

  // Reset any stuck subtasks before starting execution
  // This handles recovery from previous rate limits or crashes
  const planPath = getPlanPath(project, task);
  const resetResult = await resetStuckSubtasks(planPath, project.id);
  if (resetResult.success && resetResult.resetCount > 0) {
    console.warn(`[TASK_START] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
  }

  // Watch the plan and start the agent the task needs next (spec creation, or the build)
  watchAndStartAgent(agentManager, taskId, task, project, specDir, '[TASK_START]');
}

/** What the Stop button does, for one task (the window and the Telegram bot) */
export function stopTaskById(agentManager: AgentManager, taskId: string): void {
  stopTaskLikeStop(taskId, {
    killTask: (id) => agentManager.killTask(id),
    unwatch: (id) => fileWatcher.unwatch(id),
    findTaskAndProject,
    hasPlanWithSubtasks,
    stopTask: (id, task, project, hasPlan) => taskStateManager.stopTask(id, task, project, hasPlan),
    prepareForRestart: (id) => taskStateManager.prepareForRestart(id),
    onUnwatchError: (err) => console.error('[TASK_STOP] Failed to unwatch:', err),
  });
}

/**
 * Approve a task, or send it back to QA with the owner's instruction: what TASK_REVIEW runs for
 * the window, and the Telegram bot's "Send back".
 */
export async function reviewTask(
  agentManager: AgentManager,
  taskId: string,
  approved: boolean,
  feedback?: string,
  images?: ImageAttachment[],
  options?: { rerunOnly?: boolean }
): Promise<IPCResult> {
  // Find task and project
  const { task, project } = findTaskAndProject(taskId);

  if (!task || !project) {
    return { success: false, error: 'Task not found' };
  }

  // Check if dev mode is enabled for this project
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(
    project.path,
    specsBaseDir,
    task.specId
  );

  // Check if worktree exists - QA needs to run in the worktree where the build happened
  const worktreePath = findTaskWorktree(project.path, task.specId);
  const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;
  const hasWorktree = worktreePath !== null;

  // Sent back to the agents: a hold for the owner's preview no longer applies
  if (!approved) {
    await markWaitingForPreview([specDir, ...(worktreeSpecDir ? [worktreeSpecDir] : [])].map((dir) => path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN)), false);
  }

  if (approved) {
    // Write approval to QA report
    const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
    try {
      writeFileSync(
        qaReportPath,
        `# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`,
        'utf-8'
      );
    } catch (error) {
      console.error('[TASK_REVIEW] Failed to write QA report:', error);
      return { success: false, error: 'Failed to write QA report file' };
    }

    taskStateManager.handleUiEvent(
      taskId,
      { type: 'MARK_DONE' },
      task,
      project
    );
  } else {
    // Starting QA kills whatever runs for this task, and an agent at work has nothing to review yet
    if (agentManager.isRunning(taskId)) {
      return { success: false, error: 'An agent is still working on this task' };
    }

    if (isMergeQueued(taskId)) {
      return { success: false, error: 'This task is merging. Wait for that to finish.' };
    }

    // The agent's merge waiting for confirmation is the user's to finish or cancel: fixes would land after it
    const taskWorktree = findTaskWorktree(project.path, task.specId);
    const mergeReview = taskWorktree ? await getIntegrationReview({ worktreePath: taskWorktree, git: getToolPath('git'), env: getIsolatedGitEnv() }) : null;
    if (mergeReview) {
      return { success: false, error: 'A merge of this task is waiting for your confirmation. Commit or cancel it first.' };
    }

    // Write feedback for QA fixer - write to WORKTREE spec dir if it exists
    // The QA process runs in the worktree where the build and implementation_plan.json are
    const targetSpecDir = hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir;
    const fixRequestPath = path.join(targetSpecDir, 'QA_FIX_REQUEST.md');

    console.warn('[TASK_REVIEW] Writing QA fix request to:', fixRequestPath);
    console.warn('[TASK_REVIEW] hasWorktree:', hasWorktree, 'worktreePath:', worktreePath);

    // Process images if provided
    let imageReferences = '';
    if (images && images.length > 0) {
      const imagesDir = path.join(targetSpecDir, 'feedback_images');
      try {
        if (!existsSync(imagesDir)) {
          mkdirSync(imagesDir, { recursive: true });
        }
        const savedImages: string[] = [];
        for (const image of images) {
          try {
            if (!image.data) {
              console.warn('[TASK_REVIEW] Skipping image with no data:', image.filename);
              continue;
            }
            // Server-side MIME type validation (defense in depth - frontend also validates)
            // Reject missing mimeType to prevent bypass attacks
            const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (!image.mimeType || !ALLOWED_MIME_TYPES.includes(image.mimeType)) {
              console.warn('[TASK_REVIEW] Skipping image with missing or disallowed MIME type:', image.mimeType);
              continue;
            }
            // Sanitize filename to prevent path traversal attacks
            const sanitizedFilename = path.basename(image.filename);
            if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
              console.warn('[TASK_REVIEW] Skipping image with invalid filename:', image.filename);
              continue;
            }
            // Remove data URL prefix if present (e.g., "data:image/png;base64," or "data:image/svg+xml;base64,")
            const base64Data = image.data.replace(/^data:image\/[^;]+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const imagePath = path.join(imagesDir, sanitizedFilename);
            // Verify the resolved path is within the images directory (defense in depth)
            const resolvedPath = path.resolve(imagePath);
            const resolvedImagesDir = path.resolve(imagesDir);
            if (!resolvedPath.startsWith(resolvedImagesDir + path.sep)) {
              console.warn('[TASK_REVIEW] Skipping image with path outside target directory:', image.filename);
              continue;
            }
            writeFileSync(imagePath, imageBuffer);
            savedImages.push(`feedback_images/${sanitizedFilename}`);
            debugLog('[TASK_REVIEW] Saved image:', sanitizedFilename);
          } catch (imgError) {
            console.error('[TASK_REVIEW] Failed to save image:', image.filename, imgError);
          }
        }
        if (savedImages.length > 0) {
          imageReferences = '\n\n## Reference Images\n\n' +
            savedImages.map(imgPath => `![Feedback Image](${imgPath})`).join('\n\n');
        }
      } catch (dirError) {
        console.error('[TASK_REVIEW] Failed to create images directory:', dirError);
      }
    }

    try {
      if (options?.rerunOnly) requestQaRerun(targetSpecDir);
      else writeFileSync(
        fixRequestPath,
        `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || 'No feedback provided'}${imageReferences}\n\nCreated at: ${new Date().toISOString()}\n`,
        'utf-8'
      );
    } catch (error) {
      console.error('[TASK_REVIEW] Failed to write QA fix request:', error);
      return { success: false, error: 'Failed to write QA fix request file' };
    }

    // Clear stale tracking state before starting new QA process
    taskStateManager.prepareForRestart(taskId);

    // Restart QA process - use worktree path if it exists, otherwise main project
    // The QA process needs to run where the implementation_plan.json with completed subtasks is
    const qaProjectPath = hasWorktree ? worktreePath : project.path;
    console.warn('[TASK_REVIEW] Starting QA process with projectPath:', qaProjectPath);
    agentManager.startQAProcess(taskId, qaProjectPath, task.specId, project.id);

    taskStateManager.handleUiEvent(
      taskId,
      { type: 'USER_RESUMED' },
      task,
      project
    );
  }

  return { success: true };
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Start a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_START, (_, taskId: string, _options?: TaskStartOptions) => {
    void startTask(agentManager, getMainWindow, taskId);
  });

  // The app's checks fail on main too: one urgent task fixes main, started at once (base-fix-handler.ts)
  agentManager.on('base-failures', (taskId, data) => {
    void handleBaseFailures(
      {
        findTaskAndProject,
        getTasks: (projectId) => projectStore.getTasks(projectId),
        createTask: createTaskInProject,
        startTask: (id) => startTask(agentManager, getMainWindow, id),
        defaultModels: () => resolveDefaultTaskModels(readSettingsFile() as never),
      },
      taskId,
      data,
    ).catch((error) => console.error('[base-fix] Could not start the task that fixes main:', error));
  });

  /**
   * Stop a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
    stopTaskById(agentManager, taskId);
  });

  // The queue pause (the Telegram bot's /stop_all pauses it; the board asks before starting a queued task)
  ipcMain.handle(IPC_CHANNELS.QUEUE_PAUSED_GET, () => queuePause.isPaused());
  ipcMain.handle(IPC_CHANNELS.QUEUE_PAUSED_SET, (_, paused: boolean) => {
    queuePause.set(paused === true);
    return queuePause.isPaused();
  });
  queuePause.onChange((paused) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.QUEUE_PAUSED_CHANGED, paused);
  });

  /**
   * Review a task (approve or reject)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string,
      images?: ImageAttachment[],
      options?: { rerunOnly?: boolean }
    ): Promise<IPCResult> => {
      return reviewTask(agentManager, taskId, approved, feedback, images, options);
    }
  );

  /**
   * Update task status manually
   * Options:
   * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE_STATUS,
    async (
      _,
      taskId: string,
      status: TaskStatus,
      options?: { forceCleanup?: boolean; keepWorktree?: boolean; fromQueue?: boolean }
    ): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string; staleCiTask?: string }> => {
      // Find task and project first (needed for worktree check)
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // The queue is about to start it by itself: a task of the CI check must still have its reason
      if (status === 'in_progress' && options?.fromQueue) {
        const stale = await returnStaleQueuedTask(getMainWindow, task, project);
        if (stale) {
          console.warn(`[TASK_UPDATE_STATUS] Not starting queued task ${taskId}: ${stale}`);
          return { success: false, staleCiTask: stale, error: STALE_QUEUED_TASK_MESSAGE };
        }
      }

      // Validate status transition - 'done' can only be set through merge handler
      // UNLESS there's no worktree (limbo state - already merged/discarded or failed)
      // OR forceCleanup is requested (user confirmed they want to delete the worktree)
      // OR keepWorktree is requested (user wants to mark done without deleting worktree)
      if (status === 'done') {
        // Check if worktree exists (task.specId matches worktree folder name)
        const worktreePath = findTaskWorktree(project.path, task.specId);
        const hasWorktree = worktreePath !== null;

        if (hasWorktree) {
          if (options?.keepWorktree) {
            // User explicitly chose to keep worktree - allow marking as done
            console.warn(`[TASK_UPDATE_STATUS] Marking task ${taskId} as done while keeping worktree at ${worktreePath}`);
          } else if (options?.forceCleanup) {
            // User confirmed cleanup - delete worktree and branch
            console.warn(`[TASK_UPDATE_STATUS] Cleaning up worktree for task ${taskId} (user confirmed)`);
            // The shared cleanup: folders that deny deletion, retries, pruning, and only ever a task's own branch
            const cleanupResult = await cleanupWorktree({
              worktreePath,
              projectPath: project.path,
              specId: task.specId,
              logPrefix: '[TASK_UPDATE_STATUS]',
              specsRelPath: getSpecsDir(project.autoBuildPath),
              deleteBranch: true
            });
            if (!cleanupResult.success) {
              console.error(`[TASK_UPDATE_STATUS] Failed to cleanup worktree:`, cleanupResult.warnings);
              return {
                success: false,
                error: `Failed to cleanup worktree: ${cleanupResult.warnings.join('; ')}`
              };
            }

            // The owner closed the task with its folder: its branch on GitHub goes too
            requestTaskBranchDelete(project, task);

            console.warn(`[TASK_UPDATE_STATUS] Worktree cleanup completed successfully`);
          } else {
            // Worktree exists but no forceCleanup - return special response for UI to show confirmation
            console.warn(`[TASK_UPDATE_STATUS] Worktree exists for task ${taskId}. Requesting user confirmation.`);
            return {
              success: false,
              worktreeExists: true,
              worktreePath: worktreePath,
              error: "A worktree still exists for this task. Would you like to delete it and mark the task as complete?"
            };
          }
        } else {
          // No worktree - allow marking as done (limbo state recovery)
          console.warn(`[TASK_UPDATE_STATUS] Allowing status 'done' for task ${taskId} (no worktree found - limbo state)`);
        }
      }

      // Validate status transition - 'human_review' requires actual work to have been done
      // This prevents tasks from being incorrectly marked as ready for review when execution failed
      if (status === 'human_review') {
        const specsBaseDirForValidation = getSpecsDir(project.autoBuildPath);
        const specDirForValidation = path.join(
          project.path,
          specsBaseDirForValidation,
          task.specId
        );
        const specFilePath = path.join(specDirForValidation, AUTO_BUILD_PATHS.SPEC_FILE);

        // Check if spec.md exists and has meaningful content (at least 100 chars)
        const MIN_SPEC_CONTENT_LENGTH = 100;
        let specContent = '';
        try {
          if (existsSync(specFilePath)) {
            specContent = readFileSync(specFilePath, 'utf-8');
          }
        } catch {
          // Ignore read errors - treat as empty spec
        }

        if (!specContent || specContent.length < MIN_SPEC_CONTENT_LENGTH) {
          console.warn(`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`);
          return {
            success: false,
            error: "Cannot move to human review - no spec has been created yet. The task must complete processing before review."
          };
        }
      }

      // Get the spec directory and plan path using shared utility
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(project.path, specsBaseDir, task.specId);
      const planPath = getPlanPath(project, task);

      try {
        const handledByMachine = taskStateManager.handleManualStatusChange(taskId, status, task, project);
        if (!handledByMachine) {
          // Use shared utility for thread-safe plan file updates (legacy/manual override)
          const persisted = await persistPlanStatus(planPath, status, project.id);

          if (!persisted) {
            // If no implementation plan exists yet, create a basic one
            await createPlanIfNotExists(planPath, task, status);
            // Invalidate cache after creating new plan
            projectStore.invalidateTasksCache(project.id);
          }
        }

        // Auto-stop task when status changes AWAY from 'in_progress' and process IS running
        // This handles the case where user drags a running task back to Planning/backlog
        if (status !== 'in_progress' && agentManager.isRunning(taskId)) {
          console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
          agentManager.killTask(taskId);
        }

        // Auto-start task when status changes to 'in_progress' and no process is running
        if (status === 'in_progress' && !agentManager.isRunning(taskId)) {
          // Clear stale tracking state before starting a new process
          taskStateManager.prepareForRestart(taskId);
          const mainWindow = getMainWindow();

          // Check git status before auto-starting
          const gitStatusCheck = checkGitStatus(project.path);
          if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
            console.warn('[TASK_UPDATE_STATUS] Git check failed, cannot auto-start task');
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                gitStatusCheck.error || 'Git repository with commits required to run tasks.'
              );
            }
            return { success: false, error: gitStatusCheck.error || 'Git repository required' };
          }

          // Check the Claude credential before auto-starting
          if (!hasClaudeCredential()) {
            console.warn('[TASK_UPDATE_STATUS] No Claude credential configured');
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                MISSING_CREDENTIAL_MESSAGE
              );
            }
            return { success: false, error: 'Authentication required' };
          }

          console.warn('[TASK_UPDATE_STATUS] Auto-starting task:', taskId);

          // Cancel any pending fallback timer from previous process exit
          // This prevents the stale timer from incorrectly stopping the newly started task
          cancelFallbackTimer(taskId);

          // Reset any stuck subtasks before starting execution
          // This handles recovery from previous rate limits or crashes
          const resetResult = await resetStuckSubtasks(planPath, project.id);
          if (resetResult.success && resetResult.resetCount > 0) {
            console.warn(`[TASK_UPDATE_STATUS] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
          }

          // Watch the plan and start the agent the task needs next (spec creation, or the build)
          watchAndStartAgent(agentManager, taskId, task, project, specDir, '[TASK_UPDATE_STATUS]');

          // Notify renderer about status change
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.TASK_STATUS_CHANGE,
              taskId,
              'in_progress',
              project.id
            );
          }
        }

        return { success: true };
      } catch (error) {
        console.error('Failed to update task status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update task status'
        };
      }
    }
  );

  /**
   * Check if a task is actually running (has active process)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CHECK_RUNNING,
    async (_, taskId: string): Promise<IPCResult<boolean>> => {
      const isRunning = agentManager.isRunning(taskId);
      return { success: true, data: isRunning };
    }
  );

  /**
   * What the owner decided about subtasks the coder gave up on: skip them, or send them
   * back with an instruction. The renderer resumes the task afterwards.
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RESOLVE_FAILED_SUBTASKS,
    async (_, taskId: string, decision: unknown): Promise<IPCResult<{ changed: string[] }>> => {
      const parsed = parseFailedSubtaskDecision(decision);
      if (!parsed) return { success: false, error: 'Unknown decision' };
      if (agentManager.isRunning(taskId)) return { success: false, error: 'Task is still running' };
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) return { success: false, error: 'Task not found' };
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
      const planPaths = [worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null, mainSpecDir]
        .filter((dir): dir is string => !!dir)
        .map((dir) => path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))
        .filter((planPath) => existsSync(planPath));
      if (!planPaths.length) return { success: false, error: 'The task has no plan' };
      const decisionsFile = taskOwnerDecisionsFile(mainSpecDir);
      if (!decisionsFile) return { success: false, error: "The app's data folder could not be found" };
      return { success: true, data: await applyFailedSubtaskDecision(planPaths, parsed, decisionsFile) };
    }
  );

  /**
   * Recover a stuck task (status says in_progress but no process running)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RECOVER_STUCK,
    async (
      _,
      taskId: string,
      options?: { targetStatus?: TaskStatus; autoRestart?: boolean }
    ): Promise<IPCResult<{ taskId: string; recovered: boolean; newStatus: TaskStatus; message: string; autoRestarted?: boolean }>> => {
      const targetStatus = options?.targetStatus;
      const autoRestart = options?.autoRestart ?? false;
      // Check if task is actually running
      const isActuallyRunning = agentManager.isRunning(taskId);

      if (isActuallyRunning) {
        return {
          success: false,
          error: 'Task is still running. Stop it first before recovering.',
          data: {
            taskId,
            recovered: false,
            newStatus: 'in_progress' as TaskStatus,
            message: 'Task is still running'
          }
        };
      }

      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      // This is critical: task might exist in worktree, and getTasks() prefers worktree version.
      // If we write to main project but task is in worktree, the worktree's old status takes precedence on refresh.
      const specDir = task.specsPath || path.join(
        project.path,
        getSpecsDir(project.autoBuildPath),
        task.specId
      );

      // Update implementation_plan.json
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      debugLog(`[Recovery] Writing to plan file at: ${planPath} (task location: ${task.location || 'main'})`);

      // Also update the OTHER location if task exists in both main and worktree
      // This ensures consistency regardless of which version getTasks() prefers
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;

      // Collect all plan file paths that need updating
      const planPathsToUpdate: string[] = [planPath];
      if (mainSpecDir !== specDir && existsSync(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      if (worktreeSpecDir && worktreeSpecDir !== specDir && existsSync(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      debugLog(`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`, planPathsToUpdate);

      try {
        // Read the plan to analyze subtask progress
        // Using safe read to avoid TOCTOU race conditions
        let plan: Record<string, unknown> | null = null;
        const planContent = safeReadFileSync(planPath);
        if (planContent) {
          try {
            plan = JSON.parse(planContent);
          } catch (parseError) {
            console.error('[Recovery] Failed to parse plan file as JSON:', parseError);
            return {
              success: false,
              error: 'Plan file contains invalid JSON. The file may be corrupted.'
            };
          }
        }

        // Determine the target status intelligently based on subtask progress
        // If targetStatus is explicitly provided, use it; otherwise calculate from subtasks
        let newStatus: TaskStatus = targetStatus || 'backlog';

        if (!targetStatus && plan?.phases && Array.isArray(plan.phases)) {
          // Analyze subtask statuses to determine appropriate recovery status
          const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(plan);

          if (totalCount > 0) {
            if (allCompleted) {
              // All subtasks completed - should go to review (ai_review or human_review based on source)
              // For recovery, human_review is safer as it requires manual verification
              newStatus = 'human_review';
            } else if (completedCount > 0) {
              // Some subtasks completed, some still pending - task is in progress
              newStatus = 'in_progress';
            }
            // else: no subtasks completed, stay with 'backlog'
          }
        }

        if (plan) {
          // Update status
          plan.status = newStatus;
          plan.planStatus = newStatus === 'done' ? 'completed'
            : newStatus === 'in_progress' ? 'in_progress'
            : newStatus === 'ai_review' ? 'review'
            : newStatus === 'human_review' ? 'review'
            : 'pending';
          plan.updated_at = new Date().toISOString();

          // Sync executionPhase and xstateState with the recovery status.
          // Without this, project-store.ts uses the stale executionPhase (which has
          // priority over xstateState) when loading tasks, causing the Kanban spinner
          // to persist even though the task status has been corrected.
          plan.xstateState = newStatus;
          if (newStatus === 'human_review' || newStatus === 'done') {
            plan.executionPhase = 'complete';
          } else if (newStatus === 'backlog') {
            plan.executionPhase = 'idle';
          } else if (newStatus === 'in_progress') {
            plan.executionPhase = 'coding';
          }

          // Add recovery note
          plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;

          // Check if task is actually stuck or just completed and waiting for merge
          const { allCompleted } = checkSubtasksCompletion(plan);

          if (allCompleted) {
            debugLog('[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart');
            // Don't reset any subtasks - task is done!
            // Just update status in plan file (project store reads from file, no separate update needed)
            plan.status = 'human_review';
            plan.planStatus = 'review';
            plan.executionPhase = 'complete';
            plan.xstateState = 'human_review';

            // Write to ALL plan file locations to ensure consistency
            const planContent = JSON.stringify(plan, null, 2);
            let writeSucceededForComplete = false;
            for (const pathToUpdate of planPathsToUpdate) {
              try {
                writeFileAtomicSync(pathToUpdate, planContent);
                debugLog(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
                writeSucceededForComplete = true;
              } catch (writeError) {
                console.error(`[Recovery] Failed to write plan file at ${pathToUpdate}:`, writeError);
                // Continue trying other paths
              }
            }

            if (!writeSucceededForComplete) {
              return {
                success: false,
                error: 'Failed to write plan file during recovery (all locations failed)'
              };
            }

            // CRITICAL: Invalidate cache AFTER file writes complete
            // This ensures getTasks() returns fresh data reflecting the recovery
            projectStore.invalidateTasksCache(project.id);

            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus: 'human_review',
                message: 'Task is complete and ready for review',
                autoRestarted: false
              }
            };
          }

          // Task is not complete - reset only stuck subtasks for retry
          // Keep completed subtasks as-is so run.py can resume from where it left off
          // Use shared utility to reset stuck subtasks in ALL plan file locations
          let totalResetCount = 0;
          let resetSucceeded = false;
          let resetFailedCount = 0;
          for (const pathToUpdate of planPathsToUpdate) {
            try {
              const resetResult = await resetStuckSubtasks(pathToUpdate, project.id);
              if (resetResult.success) {
                resetSucceeded = true;
                totalResetCount += resetResult.resetCount;
                if (resetResult.resetCount > 0) {
                  debugLog(`[Recovery] Reset ${resetResult.resetCount} stuck subtask(s) in: ${pathToUpdate}`);
                }
              } else {
                resetFailedCount++;
              }
            } catch (resetError) {
              resetFailedCount++;
              console.error(`[Recovery] Failed to reset stuck subtasks at ${pathToUpdate}:`, resetError);
            }
          }

          if (!resetSucceeded) {
            return {
              success: false,
              error: 'Failed to reset stuck subtasks during recovery'
            };
          }

          if (resetFailedCount > 0) {
            console.warn(`[Recovery] Partial reset: ${totalResetCount} subtask(s) reset, but ${resetFailedCount} location(s) failed`);
          }

          debugLog(`[Recovery] Total ${totalResetCount} subtask(s) reset across all locations`);

          // Clear attempt_history.json to break infinite recovery loops.
          // Without this, the backend re-reads stuck markers from attempt_history
          // and immediately re-stucks the same subtasks after recovery.
          const specDirsToClean = new Set<string>([specDir]);
          if (mainSpecDir !== specDir) specDirsToClean.add(mainSpecDir);
          if (worktreeSpecDir && worktreeSpecDir !== specDir) specDirsToClean.add(worktreeSpecDir);

          for (const dir of specDirsToClean) {
            const attemptHistoryPath = path.join(dir, 'memory', 'attempt_history.json');
            const historyContent = safeReadFileSync(attemptHistoryPath);
            if (!historyContent) continue;

            try {
              const history = JSON.parse(historyContent);

              // Collect stuck subtask IDs before clearing
              const stuckIds = new Set<string>(
                (history.stuck_subtasks || [])
                  .map((s: { subtask_id?: string }) => s.subtask_id)
                  .filter((id: string | undefined): id is string => Boolean(id))
              );

              // Clear stuck_subtasks array
              history.stuck_subtasks = [];

              // Reset attempt entries for previously-stuck subtasks
              if (history.subtasks && stuckIds.size > 0) {
                for (const stuckId of stuckIds) {
                  if (history.subtasks[stuckId]) {
                    history.subtasks[stuckId] = { attempts: [], status: 'pending' };
                  }
                }
              }

              history.metadata = {
                ...history.metadata,
                last_updated: new Date().toISOString()
              };

              writeFileAtomicSync(attemptHistoryPath, JSON.stringify(history, null, 2));
              debugLog(`[Recovery] Cleared attempt_history.json at: ${dir} (reset ${stuckIds.size} stuck entries)`);
            } catch (historyErr) {
              console.warn(`[Recovery] Could not parse attempt_history at ${dir}:`, historyErr);
            }
          }
        }

        // Stop file watcher if it was watching this task
        fileWatcher.unwatch(taskId).catch((err) => {
          console.error('[TASK_RECOVER_STUCK] Failed to unwatch:', err);
        });

        // Auto-restart the task if requested
        let autoRestarted = false;
        if (autoRestart) {
          // Clear stale tracking state before restarting
          taskStateManager.prepareForRestart(taskId);
          // Check git status before auto-restarting
          const gitStatusForRestart = checkGitStatus(project.path);
          if (!gitStatusForRestart.isGitRepo || !gitStatusForRestart.hasCommits) {
            console.warn('[Recovery] Git check failed, cannot auto-restart task');
            // Recovery succeeded but we can't restart without git
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: `Task recovered but cannot restart: ${gitStatusForRestart.error || 'Git repository with commits required.'}`,
                autoRestarted: false
              }
            };
          }

          // Check the Claude credential before auto-restarting
          if (!hasClaudeCredential()) {
            console.warn('[Recovery] Auth check failed, cannot auto-restart task');
            // Recovery succeeded but we can't restart without auth
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: 'Task recovered but cannot restart: add an Anthropic API key or a Claude subscription token in Settings > Claude.',
                autoRestarted: false
              }
            };
          }

          try {
            // Cancel any pending fallback timer from previous process exit
            // This prevents the stale timer from incorrectly stopping the restarted task
            cancelFallbackTimer(taskId);

            // Set status to in_progress for the restart
            newStatus = 'in_progress';

            // Update plan status for restart - write to ALL locations
            if (plan) {
              plan.status = 'in_progress';
              plan.planStatus = 'in_progress';
              const restartPlanContent = JSON.stringify(plan, null, 2);
              for (const pathToUpdate of planPathsToUpdate) {
                try {
                  writeFileAtomicSync(pathToUpdate, restartPlanContent);
                  debugLog(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
                } catch (writeError) {
                  console.error(`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`, writeError);
                  // Continue with restart attempt even if file write fails
                  // The plan status will be updated by the agent when it starts
                }
              }

              // CRITICAL: Invalidate cache AFTER file writes complete
              // This ensures getTasks() returns fresh data reflecting the restart status
              projectStore.invalidateTasksCache(project.id);
            }

            // Watch the plan and start the agent the task needs next (spec creation, or the build).
            // mainSpecDir is the project's spec folder: the spec is created before the worktree
            watchAndStartAgent(agentManager, taskId, task, project, mainSpecDir, '[Recovery]');

            autoRestarted = true;
            console.warn(`[Recovery] Auto-restarted task ${taskId}`);
          } catch (restartError) {
            console.error('Failed to auto-restart task after recovery:', restartError);
            // Recovery succeeded but restart failed - still report success
          }
        }

        // Notify renderer of status change
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            newStatus,
            project.id
          );
        }

        return {
          success: true,
          data: {
            taskId,
            recovered: true,
            newStatus,
            message: autoRestarted
              ? 'Task recovered and restarted successfully'
              : `Task recovered successfully and moved to ${newStatus}`,
            autoRestarted
          }
        };
      } catch (error) {
        console.error('Failed to recover stuck task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recover task'
        };
      }
    }
  );
}
