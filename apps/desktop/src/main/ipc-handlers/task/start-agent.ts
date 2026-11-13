/**
 * Starting the agent a task needs next. One place for what start, start from the queue and
 * recovery all do once they have decided that the task runs.
 */
import { existsSync } from 'fs';
import path from 'path';

import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, Task } from '../../../shared/types';
import type { AgentManager } from '../../agent';
import { fileWatcher } from '../../file-watcher';
import { findTaskWorktree } from '../../worktree-paths';

/**
 * The spec folder to watch for plan changes: the worktree's once the plan is there (a task that
 * runs in a worktree writes implementation_plan.json there), else the project's.
 */
export function specDirForWatcher(projectPath: string, specsBaseDir: string, specId: string): string {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    const worktreeSpecDir = path.join(worktreePath, specsBaseDir, specId);
    if (existsSync(path.join(worktreeSpecDir, 'implementation_plan.json'))) {
      return worktreeSpecDir;
    }
  }
  return path.join(projectPath, specsBaseDir, specId);
}

/**
 * Watches the task's plan file and starts its agent: spec creation when the task has no
 * spec.md yet (`specDir` is the project's spec folder: the spec is written before any worktree
 * exists), otherwise the build, which plans first when the plan has no subtasks. The base
 * branch is the task's own, then the project's. `taskId` is the id the caller was given (the
 * task's id or its spec id). Returns which of the two was started.
 */
export function watchAndStartAgent(
  agentManager: Pick<AgentManager, 'startSpecCreation' | 'startTaskExecution'>,
  taskId: string,
  task: Task,
  project: Project,
  specDir: string,
  logPrefix: string,
): 'spec' | 'build' {
  const watchSpecDir = specDirForWatcher(project.path, getSpecsDir(project.autoBuildPath), task.specId);
  fileWatcher.watch(taskId, watchSpecDir).catch((err) => {
    console.error(`${logPrefix} Failed to watch spec dir for ${taskId}:`, err);
  });

  const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;

  if (!existsSync(path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE))) {
    console.warn(`${logPrefix} Starting spec creation for:`, task.specId);
    void agentManager.startSpecCreation(taskId, project.path, task.description || task.title, specDir, task.metadata, baseBranch, project.id);
    return 'spec';
  }

  console.warn(`${logPrefix} Starting task execution for:`, task.specId);
  void agentManager.startTaskExecution(
    taskId,
    project.path,
    task.specId,
    {
      parallel: false,
      workers: 1,
      baseBranch,
      useWorktree: task.metadata?.useWorktree,
      useLocalBranch: task.metadata?.useLocalBranch,
      pushNewBranches: task.metadata?.pushNewBranches
    },
    project.id
  );
  return 'build';
}
