/**
 * The project's auto-merge: a task QA approved merges by itself, the way the Merge
 * button does it. Anything less than a clean result stays with the user, and a merge
 * an agent changed code for still waits for their review. Runs only as a task
 * arrives in review, so turning the switch on merges nothing already waiting. What
 * is read here decides whether to ask; the main process checks QA's approval itself.
 */
import type { Task, TaskStatus } from '../../shared/types';

export interface AutoMergeApi {
  getTaskMergeState: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: unknown }>;
  getTaskSecurityQaError: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: unknown }>;
  getTaskVerification: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: { status?: string } | null }>;
  mergeWorktree: (taskId: string, options: { auto: true; projectId?: string }) => Promise<{ success: boolean; error?: string; data?: { success?: boolean; message?: string; heldForPreview?: boolean } }>;
}

interface AutoMergeOptions {
  api: AutoMergeApi;
  getTask: (taskId: string) => Task | undefined;
  /** May be async (the deploy ledger is asked): it is awaited before any merge */
  isEnabled: (task: Task) => boolean | Promise<boolean>;
  onProblem: (taskId: string, message: string) => void;
  /** Held for the owner's preview ("UI tasks wait for my preview"): it waits, nothing failed */
  onHeld?: (taskId: string) => void;
  /** It left review: a hold no longer applies */
  onLeft?: (taskId: string) => void;
}

export function createAutoMerge({ api, getTask, isEnabled, onProblem, onHeld, onLeft }: AutoMergeOptions) {
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
        if (oldStatus === 'human_review') onLeft?.(taskId);
        return;
      }
      if (oldStatus === 'human_review' || tried.has(taskId)) return;
      const task = getTask(taskId);
      if (!task || task.reviewReason !== 'completed') return;
      // Marked before the first await, so a second arrival in the meantime does not try again
      tried.add(taskId);
      try {
        if (!(await isEnabled(task))) return;
        if (!(await clean(task))) return;
        const result = await api.mergeWorktree(taskId, { auto: true, projectId: task.projectId });
        if (result.data?.heldForPreview) onHeld?.(taskId);
        else if (!result.success || !result.data?.success) onProblem(taskId, result.data?.message ?? result.error ?? '');
      } catch (error) {
        onProblem(taskId, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
