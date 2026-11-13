/**
 * Confirms deleting a task (its spec, plan and worktree), warning about uncommitted worktree
 * changes. Shared by the task window and the task card's menu.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
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
import { deleteTask } from '../../stores/task-store';
import type { Task } from '../../../shared/types';

interface DeleteTaskDialogProps {
  task: Pick<Task, 'id' | 'title'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the task is deleted (the dialog has closed) */
  onDeleted?: () => void;
}

export function DeleteTaskDialog({ task, open, onOpenChange, onDeleted }: DeleteTaskDialogProps) {
  const { t } = useTranslation(['tasks']);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [changes, setChanges] = useState<{ hasChanges: boolean; changedFileCount?: number } | null>(null);

  // Uncommitted worktree changes, checked each time the dialog opens
  useEffect(() => {
    if (!open) {
      setChanges(null);
      setError(null);
      return;
    }
    let live = true;
    setIsChecking(true);
    Promise.resolve(window.electronAPI?.checkWorktreeChanges?.(task.id))
      .then((result) => {
        if (live && result?.success && result.data) setChanges(result.data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setIsChecking(false);
      });
    return () => {
      live = false;
    };
  }, [open, task.id]);

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    const result = await deleteTask(task.id);
    setIsDeleting(false);
    if (result.success) {
      onOpenChange(false);
      onDeleted?.();
    } else {
      setError(result.error || t('tasks:taskDetail.deleteFailed'));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !isDeleting && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {t('tasks:deleteDialog.title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground space-y-3">
              <p>
                {t('tasks:deleteDialog.confirmMessage')} <strong className="text-foreground">"{task.title}"</strong>?
              </p>
              {isChecking && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('tasks:deleteDialog.checkingChanges')}
                </div>
              )}
              {changes?.hasChanges && (
                <div className="bg-amber-500/10 border border-amber-500/30 px-3 py-2 rounded-lg text-sm space-y-1">
                  <p className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" />
                    {t('tasks:deleteDialog.uncommittedChanges', { count: changes.changedFileCount })}
                  </p>
                  <p className="text-muted-foreground text-xs">{t('tasks:deleteDialog.uncommittedChangesHint')}</p>
                </div>
              )}
              <p className="text-destructive">{t('tasks:deleteDialog.destructiveWarning')}</p>
              {error && <p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">{error}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t('tasks:deleteDialog.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleDelete();
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('tasks:deleteDialog.deleting')}
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                {t('tasks:deleteDialog.deletePermanently')}
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
