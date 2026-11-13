/**
 * Puts a task main created in the queue: its plan says 'queue' and the window hears about it.
 * The board starts queued tasks as slots free up (KanbanBoard processQueue), so the project's
 * parallel-task limit holds. Without an open board the task simply waits in the queue.
 *
 * That wait can be long, so a task of the CI check is looked at again when the queue is about
 * to start it (returnStaleQueuedTask): one whose reason is gone goes back to Planning instead
 * of spending tokens.
 */

import type { BrowserWindow } from 'electron';

import type { Project, Task } from '../../../shared/types';

import { IPC_CHANNELS } from '../../../shared/constants';
import { type StaleDeployTask, staleQueuedDeployTask } from '../../deploy/deploy-tasks';
import { readReadiness } from '../../deploy/readiness-store';
import { projectStore } from '../../project-store';
import { safeSendToRenderer } from '../utils';
import { createPlanIfNotExists, getPlanPath, persistPlanStatus } from './plan-file-utils';
import { findTaskAndProject } from './shared';

export async function queueTask(getMainWindow: () => BrowserWindow | null, taskId: string): Promise<void> {
  const { task, project } = findTaskAndProject(taskId);
  if (!task || !project) return;
  const planPath = getPlanPath(project, task);
  if (!(await persistPlanStatus(planPath, 'queue', project.id))) {
    await createPlanIfNotExists(planPath, task, 'queue');
    projectStore.invalidateTasksCache(project.id);
  }
  safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, 'queue', project.id);
}

/** What the window is told when the queue would have started a task of the CI check that no longer applies */
export const STALE_QUEUED_TASK_MESSAGE = 'The CI check created this task for a problem it no longer reports. The task is back in Planning: start it yourself if it is still needed.';

/**
 * Called when the queue is about to start a task. A task of the CI check whose reason is gone
 * (see staleQueuedDeployTask) is put back in Planning and the reason is returned; the caller
 * then does not start it. Undefined: start it. Starting a task by hand never comes through here.
 */
export async function returnStaleQueuedTask(
  getMainWindow: () => BrowserWindow | null,
  task: Task,
  project: Project,
): Promise<StaleDeployTask | undefined> {
  let stale: StaleDeployTask | undefined;
  try {
    stale = staleQueuedDeployTask(project, task.specId, readReadiness(project.path));
  } catch {
    // An unreadable ledger says nothing: the task starts as any queued task does
    return undefined;
  }
  if (!stale) return undefined;
  await persistPlanStatus(getPlanPath(project, task), 'backlog', project.id);
  safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, task.id, 'backlog', project.id);
  return stale;
}
