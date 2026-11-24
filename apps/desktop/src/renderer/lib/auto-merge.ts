/**
 * The project's auto-merge: a task QA approved merges by itself, the way the Merge
 * button does it. Anything less than a clean result stays with the user, and a merge
 * an agent changed code for still waits for their review. Runs only as a task
 * arrives in review, so turning the switch on merges nothing already waiting. What
 * is read here decides whether to ask; the main process checks QA's approval itself.
 */
import type { Task, TaskStatus } from '../../shared/types';

/** A frame of the design QA could not show in the running app */
export interface UnseenScreen {
  file: string;
  width: number;
  title: string;
  reason: string;
}

export interface AutoMergeApi {
  getTaskMergeState: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: unknown }>;
  getTaskSecurityQaError: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: unknown }>;
  getTaskVerification: (taskId: string, projectId?: string) => Promise<{ success: boolean; data?: { status?: string; source?: string } | null }>;
  mergeWorktree: (taskId: string, options: { auto: true; projectId?: string }) => Promise<{ success: boolean; error?: string; data?: { success?: boolean; message?: string; heldForPreview?: boolean; heldForScreens?: UnseenScreen[] } }>;
}

interface AutoMergeOptions {
  api: AutoMergeApi;
  getTask: (taskId: string) => Task | undefined;
  /** May be async (the deploy ledger is asked): it is awaited before any merge */
  isEnabled: (task: Task) => boolean | Promise<boolean>;
  onProblem: (taskId: string, message: string) => void;
  /** Held for the owner's preview ("UI tasks wait for my preview"): it waits, nothing failed */
  onHeld?: (taskId: string) => void;
  /** Held for frames of the design QA could not show: the owner checks these, then merges */
  onScreens?: (taskId: string, screens: UnseenScreen[]) => void;
  /** It left review: a hold no longer applies */
  onLeft?: (taskId: string) => void;
}

export function createAutoMerge({ api, getTask, isEnabled, onProblem, onHeld, onLeft, onScreens }: AutoMergeOptions) {
  const tried = new Set<string>();

  const clean = async (task: Task): Promise<boolean> => {
    const [merge, security, checks] = await Promise.all([
      api.getTaskMergeState(task.id, task.projectId),
      api.getTaskSecurityQaError(task.id, task.projectId),
      api.getTaskVerification(task.id, task.projectId),
    ]);
    // A pass on checks the task chose itself (main had none yet) is not enough to merge unattended
    return merge.success && !merge.data && security.success && !security.data && checks.success && checks.data?.status === 'passed' && !checks.data.source;
  };

  /** Merge a task QA approved, the way the button does. Reports a refusal; never throws. */
  const tryMerge = async (task: Task): Promise<void> => {
    try {
      if (!(await isEnabled(task))) return;
      if (!(await clean(task))) return;
      const result = await api.mergeWorktree(task.id, { auto: true, projectId: task.projectId });
      if (result.data?.heldForPreview) onHeld?.(task.id);
      else if (result.data?.heldForScreens?.length) onScreens?.(task.id, result.data.heldForScreens);
      else if (!result.success || !result.data?.success) onProblem(task.id, result.data?.message ?? result.error ?? '');
    } catch (error) {
      onProblem(task.id, error instanceof Error ? error.message : String(error));
    }
  };

  const waitsApproved = (task: Task) => task.status === 'human_review' && task.reviewReason === 'completed';

  return {
    /**
     * Of these tasks, the ones that already wait in review and would merge by themselves now (QA
     * approved, checks clean): offered when the switch is turned on, since arrival alone triggers it.
     */
    async mergeable(tasks: Task[]): Promise<Task[]> {
      const found: Task[] = [];
      for (const task of tasks) {
        if (!waitsApproved(task)) continue;
        try {
          if ((await isEnabled(task)) && (await clean(task))) found.push(task);
        } catch {
          // left to the owner
        }
      }
      return found;
    },

    /** Merge waiting tasks the owner said yes to, one at a time. Never throws. */
    async mergeNow(tasks: Task[]): Promise<void> {
      for (const task of tasks) {
        if (!waitsApproved(task) || tried.has(task.id)) continue;
        tried.add(task.id);
        await tryMerge(task);
      }
    },

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
      await tryMerge(task);
    },
  };
}
