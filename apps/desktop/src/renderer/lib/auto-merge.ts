/**
 * The project's auto-merge: a task QA approved merges by itself, the way the Merge
 * button does it. Anything less than a clean result stays with the user, and a merge
 * an agent changed code for still waits for their review. Runs only as a task
 * arrives in review, so turning the switch on merges nothing already waiting.
 */
import type { Task, TaskStatus } from '../../shared/types';

export interface AutoMergeApi {
  getTaskMergeState: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: unknown }>;
  getTaskSecurityQaError: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: unknown }>;
  getTaskVerification: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: { status?: string } | null }>;
  mergeWorktree: (taskId: string) => Promise<{ success: boolean; error?: string; data?: { success?: boolean; message?: string } }>;
}

interface AutoMergeOptions {
  api: AutoMergeApi;
  getTask: (taskId: string) => Task | undefined;
  isEnabled: (task: Task) => boolean;
  onProblem: (taskId: string, message: string) => void;
}

export function createAutoMerge({ api, getTask, isEnabled, onProblem }: AutoMergeOptions) {
  const tried = new Set<string>();

  const clean = async (task: Task): Promise<boolean> => {
    const [merge, security, checks] = await Promise.all([
      api.getTaskMergeState(task.id, task.projectId),
      api.getTaskSecurityQaError(task.id, task.projectId),
      api.getTaskVerification(task.id, task.projectId),
    ]);
    return merge.success && !merge.data && security.success && !security.data && checks.success && checks.data?.status === 'passed';
  };

  return {
    async statusChanged(taskId: string, oldStatus: TaskStatus | undefined, newStatus: TaskStatus): Promise<void> {
      if (newStatus !== 'human_review') {
        tried.delete(taskId);
        return;
      }
      if (oldStatus === 'human_review' || tried.has(taskId)) return;
      const task = getTask(taskId);
      if (!task || task.reviewReason !== 'completed' || !isEnabled(task)) return;
      tried.add(taskId);
      try {
        if (!(await clean(task))) return;
        const result = await api.mergeWorktree(taskId);
        if (!result.success || !result.data?.success) onProblem(taskId, result.data?.message ?? result.error ?? '');
      } catch (error) {
        onProblem(taskId, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
