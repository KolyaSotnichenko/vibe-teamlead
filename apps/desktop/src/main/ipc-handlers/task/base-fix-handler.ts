/**
 * The app's checks fail on main too (verification/base-fix.ts): create one task that fixes main,
 * urgent, and start it at once, past the queue. One per failing command while it is open.
 */

import type { Project, Task, TaskMetadata } from '../../../shared/types';
import { baseFixTask, type BaseFailure, openBaseFix, recordBaseFix } from '../../ai/verification/base-fix';

export interface BaseFixDeps {
  findTaskAndProject: (taskId: string) => { task?: Task; project?: Project };
  getTasks: (projectId: string) => Task[];
  createTask: (project: Project, title: string, description: string, metadata: TaskMetadata) => Promise<Task>;
  startTask: (taskId: string) => Promise<void>;
  /** The user's default models for a new task */
  defaultModels?: () => Partial<TaskMetadata>;
}

/** Done or handed over as a PR: no longer fixing anything */
const CLOSED = new Set(['done', 'pr_created']);
/** project|command being created right now: two tasks can report it in the same moment */
const creating = new Set<string>();

export async function handleBaseFailures(deps: BaseFixDeps, taskId: string, data: { failures: BaseFailure[]; baseCommit: string }): Promise<void> {
  const { task, project } = deps.findTaskAndProject(taskId);
  if (!task || !project || !data.failures.length) return;
  // The fix task sees main fail too, until its own fix lands
  if (task.metadata?.sourceType === 'base-fix') return;

  const commands = data.failures.map((failure) => failure.command);
  const keys = commands.map((command) => `${project.path}|${command}`);
  if (keys.some((key) => creating.has(key))) return;
  const isOpen = (specId: string) => deps.getTasks(project.id).some((t) => t.specId === specId && !CLOSED.has(t.status));
  if (openBaseFix(project.path, commands, isOpen)) return;

  for (const key of keys) creating.add(key);
  try {
    const { title, description } = baseFixTask(data.failures, data.baseCommit, project.settings?.mainBranch || 'main');
    const created = await deps.createTask(project, title, description, {
      ...(deps.defaultModels?.() ?? {}),
      sourceType: 'base-fix',
      category: 'bug_fix',
      priority: 'urgent',
    });
    recordBaseFix(project.path, commands, created.specId);
    await deps.startTask(created.id);
  } finally {
    for (const key of keys) creating.delete(key);
  }
}
