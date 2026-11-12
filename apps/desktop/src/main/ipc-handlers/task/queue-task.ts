/**
 * Puts a task main created in the queue: its plan says 'queue' and the window hears about it.
 * The board starts queued tasks as slots free up (KanbanBoard processQueue), so the project's
 * parallel-task limit holds. Without an open board the task simply waits in the queue.
 */

import type { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';
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
