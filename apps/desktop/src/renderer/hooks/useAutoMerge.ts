import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createAutoMerge, type AutoMergeApi } from '../lib/auto-merge';
import { useProjectStore } from '../stores/project-store';
import { useTaskStore } from '../stores/task-store';
import { toast } from './use-toast';

/** At the app's level: a task finishes QA whatever screen is open. */
export function useAutoMerge(): void {
  const { t } = useTranslation('tasks');

  useEffect(() => {
    const auto = createAutoMerge({
      api: window.electronAPI as unknown as AutoMergeApi,
      getTask: (taskId) => useTaskStore.getState().tasks.find((task) => task.id === taskId || task.specId === taskId),
      isEnabled: (task) => useProjectStore.getState().projects.find((project) => project.id === task.projectId)?.settings?.autoMerge === true,
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
