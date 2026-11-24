import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createAutoMerge, type AutoMergeApi, type UnseenScreen } from '../lib/auto-merge';
import type { Project } from '../../shared/types/project';
import type { Task } from '../../shared/types/task';
import { useProjectStore } from '../stores/project-store';
import { useTaskStore } from '../stores/task-store';
import { toast } from './use-toast';

/**
 * Whether QA's approval merges this task by itself: the project switch, or a task the deploy
 * ledger created (blocker and fix tasks). The metadata alone is not enough: pipeline agents write
 * it, so the app's own ledger must hold the spec too.
 */
export async function autoMergeEnabled(
  project: Pick<Project, 'id' | 'settings'> | undefined,
  task: Pick<Task, 'specId' | 'metadata'>,
  isDeployTask: (projectId: string, specId: string) => Promise<boolean>,
): Promise<boolean> {
  if (project?.settings?.autoMerge === true) return true;
  if (!project || task.metadata?.sourceType !== 'deploy') return false;
  return isDeployTask(project.id, task.specId);
}

let current: ReturnType<typeof createAutoMerge> | undefined;

/** The app's auto-merge, for offering the tasks that already wait when the switch is turned on. */
export function getAutoMerge(): ReturnType<typeof createAutoMerge> | undefined {
  return current;
}

/** At the app's level: a task finishes QA whatever screen is open. */
export function useAutoMerge(): void {
  const { t } = useTranslation('tasks');

  useEffect(() => {
    const auto = createAutoMerge({
      api: window.electronAPI as unknown as AutoMergeApi,
      getTask: (taskId) => useTaskStore.getState().tasks.find((task) => task.id === taskId || task.specId === taskId),
      isEnabled: (task) =>
        autoMergeEnabled(
          useProjectStore.getState().projects.find((project) => project.id === task.projectId),
          task,
          (projectId, specId) => window.electronAPI.deploy.isDeployTask(projectId, specId),
        ),
      onHeld: (taskId) => useTaskStore.getState().updateTask(taskId, { waitingForPreview: true }),
      onLeft: (taskId) => useTaskStore.getState().updateTask(taskId, { waitingForPreview: false }),
      // Not a failure: the owner checks the screens QA couldn't show, then merges
      onScreens: (taskId, screens) => {
        const title = useTaskStore.getState().tasks.find((task) => task.id === taskId)?.title ?? taskId;
        toast({
          title: t('queue.screensToCheck', { count: screens.length, title }),
          description: <ScreensToCheck screens={screens} how={t('queue.screensToCheckHow')} line={(s) => t('queue.screenToCheck', { title: s.title, width: s.width })} why={(s) => t('queue.screenToCheckWhy', { reason: s.reason })} />,
          duration: 60_000,
        });
      },
      onProblem: (taskId, message) => {
        const title = useTaskStore.getState().tasks.find((task) => task.id === taskId)?.title ?? taskId;
        toast({ title: t('queue.autoMergeFailed', { title }), description: message, variant: 'destructive' });
      },
    });
    current = auto;
    const unsubscribe = useTaskStore.getState().registerTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      void auto.statusChanged(taskId, oldStatus, newStatus);
    });
    return () => {
      unsubscribe();
      if (current === auto) current = undefined;
    };
  }, [t]);
}

/** The screens of a held merge: what to look at, and why QA couldn't */
function ScreensToCheck({ screens, how, line, why }: { screens: UnseenScreen[]; how: string; line: (s: UnseenScreen) => string; why: (s: UnseenScreen) => string }) {
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {screens.slice(0, 8).map((s) => (
          <li key={`${s.file}-${s.width}`}>
            <span className="font-medium">{line(s)}</span>
            <span className="block text-xs opacity-80">{why(s)}</span>
          </li>
        ))}
      </ul>
      <p>{how}</p>
    </div>
  );
}
