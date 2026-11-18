/**
 * A project's queue settings (Settings → Project → Queue): how many tasks may be under way,
 * and whether tasks QA approved merge by themselves. Writing them is the project settings'
 * save; this holds what else a save means. A larger limit starts queued tasks by itself, whatever
 * screen is open (useQueueProcessor follows the project's limit). Turning auto-merge on offers
 * the tasks that already wait: only arrival in review merges a task by itself, so those would
 * wait forever.
 */
import { create } from 'zustand';
import type { ProjectSettings, Task } from '../../shared/types';
import { MAX_PARALLEL_TASKS } from '../../shared/utils/task-slots';
import { getAutoMerge } from '../hooks/useAutoMerge';
import { useTaskStore } from '../stores/task-store';

type QueueSettings = Pick<ProjectSettings, 'maxParallelTasks' | 'autoMerge' | 'previewBeforeAutoMerge'>;

/** The i18n key of what is wrong with a parallel task limit, or null when it is allowed. */
export function maxParallelError(value: number): string | null {
  if (!(value >= 1)) return 'tasks:queue.settings.minValueError';
  if (value > MAX_PARALLEL_TASKS) return 'tasks:queue.settings.maxValueError';
  return null;
}

/**
 * Whether the edited settings may be saved. The limit is checked only when it was changed, so
 * a value saved under an older maximum does not stop the project's other settings from saving.
 */
export function queueSettingsError(saved: QueueSettings, edited: QueueSettings): string | null {
  if (edited.maxParallelTasks === saved.maxParallelTasks || edited.maxParallelTasks === undefined) return null;
  return maxParallelError(edited.maxParallelTasks);
}

type WaitingTask = Pick<Task, 'id' | 'title'>;

interface MergeWaitingState {
  /** Tasks offered for merging now; empty when nothing is offered */
  tasks: WaitingTask[];
  offer: (tasks: WaitingTask[]) => void;
  dismiss: () => void;
}

export const useMergeWaitingStore = create<MergeWaitingState>((set) => ({
  tasks: [],
  offer: (tasks) => set({ tasks }),
  dismiss: () => set({ tasks: [] }),
}));

/** After the project's settings were saved: the effects of a changed queue setting. */
export async function queueSettingsSaved(projectId: string, saved: QueueSettings, edited: QueueSettings): Promise<void> {
  if (edited.autoMerge !== true || saved.autoMerge === true) return;
  const waiting = useTaskStore
    .getState()
    .tasks.filter((task) => task.projectId === projectId && task.status === 'human_review');
  const found = (await getAutoMerge()?.mergeable(waiting)) ?? [];
  useMergeWaitingStore.getState().offer(found);
}
