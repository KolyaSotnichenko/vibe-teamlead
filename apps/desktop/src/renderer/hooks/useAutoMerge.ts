import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createAutoMerge, type AutoMergeApi } from '../lib/auto-merge';
import type { Project } from '../../shared/types/project';
import type { Task } from '../../shared/types/task';
import { useProjectStore } from '../stores/project-store';
import { useTaskStore } from '../stores/task-store';
import { toast } from './use-toast';

/**
 * Whether QA's approval merges this task by itself. Deploy tasks (blocker and fix
 * tasks from the readiness scan) always do; everything else follows the project switch.
 */
export function autoMergeEnabled(project: Pick<Project, 'settings'> | undefined, task: Pick<Task, 'metadata'>): boolean {
  return project?.settings?.autoMerge === true || task.metadata?.sourceType === 'deploy';
}

/** At the app's level: a task finishes QA whatever screen is open. */
export function useAutoMerge(): void {
  const { t } = useTranslation('tasks');

  useEffect(() => {
    const auto = createAutoMerge({
      api: window.electronAPI as unknown as AutoMergeApi,
      getTask: (taskId) => useTaskStore.getState().tasks.find((task) => task.id === taskId || task.specId === taskId),
      isEnabled: (task) => autoMergeEnabled(useProjectStore.getState().projects.find((project) => project.id === task.projectId), task),
      onHeld: (taskId) => useTaskStore.getState().updateTask(taskId, { waitingForPreview: true }),
      onLeft: (taskId) => useTaskStore.getState().updateTask(taskId, { waitingForPreview: false }),
      onProblem: (taskId, message) => {
        const title = useTaskStore.getState().tasks.find((task) => task.id === taskId)?.title ?? taskId;
        toast({ title: t('queue.autoMergeFailed', { title }), description: message, variant: 'destructive' });
      },
    });
    return useTaskStore.getState().registerTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      void auto.statusChanged(taskId, oldStatus, newStatus);
    });
  }, [t]);
}
