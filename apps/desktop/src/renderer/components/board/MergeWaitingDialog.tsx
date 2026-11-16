/**
 * Auto-merge was just turned on while tasks QA approved already wait in review. Arrival is what
 * merges a task by itself, so these would wait forever: the owner is asked once, and they merge
 * only on yes.
 */
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';

interface MergeWaitingDialogProps {
  tasks: Pick<Task, 'id' | 'title'>[];
  onMerge: (tasks: Pick<Task, 'id' | 'title'>[]) => void;
  onClose: () => void;
}

export function MergeWaitingDialog({ tasks, onMerge, onClose }: MergeWaitingDialogProps) {
  const { t } = useTranslation('tasks');
  if (!tasks.length) return null;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-[500px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('queue.mergeWaiting.title', { count: tasks.length })}</AlertDialogTitle>
          <AlertDialogDescription>{t('queue.mergeWaiting.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <ol className="max-h-48 space-y-1 overflow-y-auto border border-border p-2 text-sm">
          {tasks.map((task, i) => (
            <li key={task.id} className="flex gap-2">
              <span className="font-mono text-xs leading-5 text-muted-foreground">{i + 1}.</span>
              <span className="min-w-0 truncate">{task.title}</span>
            </li>
          ))}
        </ol>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t('queue.mergeWaiting.notNow')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onMerge(tasks);
              onClose();
            }}
          >
            {t('queue.mergeWaiting.merge', { count: tasks.length })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
