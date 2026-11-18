import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { parallelTaskLimit } from '../../shared/utils/task-slots';
import { isReadyToStart } from '../lib/task-dependencies';
import { createQueueProcessor } from '../lib/queue-processor';
import { useProjectStore } from '../stores/project-store';
import { syncQueuePause, useQueuePauseStore } from '../stores/queue-pause-store';
import { persistTaskStatus, useTaskStore } from '../stores/task-store';
import { occupiesSlot } from '../../shared/utils/task-slots';
import { toast } from './use-toast';

/** The loaded project's parallel-task limit (the tasks loaded are one project's) */
function currentLimit(): number {
  const projectId = useTaskStore.getState().tasks[0]?.projectId;
  const project = projectId ? useProjectStore.getState().projects.find((p) => p.id === projectId) : undefined;
  return parallelTaskLimit(project?.settings?.maxParallelTasks);
}

/**
 * At the app's level: queued tasks start whatever screen is open, when a slot comes free, a
 * task joins the queue or its dependencies finish, the limit grows (Settings → Project → Queue)
 * or the queue is resumed.
 */
export function useQueueProcessor(): void {
  const { t } = useTranslation('tasks');

  const processor = useMemo(
    () =>
      createQueueProcessor({
        getTasks: () => useTaskStore.getState().tasks,
        limit: currentLimit,
        paused: () => useQueuePauseStore.getState().paused,
        promote: (taskId) => persistTaskStatus(taskId, 'in_progress', { fromQueue: true }),
        onStaleCiTask: (task) => toast({ title: t('queue.staleCiTask', { title: task.title }) }),
      }),
    [t],
  );

  // The queue pause lives in main
  useEffect(() => syncQueuePause(), []);

  // A task that leaves In Progress frees a slot; one that is done may unblock others; one that joins the queue may start
  useEffect(
    () =>
      useTaskStore.getState().registerTaskStatusChangeListener((_taskId, oldStatus, newStatus) => {
        if ((oldStatus === 'in_progress' && newStatus !== 'in_progress') || newStatus === 'done' || newStatus === 'queue') void processor.process();
      }),
    [processor],
  );

  // Without a status change in this window: tasks created straight into the queue, loaded with
  // the project, a slot freed by a delete or an archive, a larger limit, the queue resumed
  const readyQueuedKey = useTaskStore((state) =>
    state.tasks
      .filter((task) => task.status === 'queue' && !task.metadata?.archivedAt && isReadyToStart(task, state.tasks))
      .map((task) => task.id)
      .join(','),
  );
  const slotsInUse = useTaskStore((state) => state.tasks.filter(occupiesSlot).length);
  const limit = useProjectStore((state) => {
    const projectId = useTaskStore.getState().tasks[0]?.projectId;
    return parallelTaskLimit(state.projects.find((p) => p.id === projectId)?.settings?.maxParallelTasks);
  });
  const paused = useQueuePauseStore((state) => state.paused);
  useEffect(() => {
    if (readyQueuedKey && !paused) void processor.process();
  }, [readyQueuedKey, slotsInUse, limit, paused, processor]);
}
