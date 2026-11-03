import { useTranslation } from 'react-i18next';
import { Play, RotateCcw, Loader2 } from 'lucide-react';

interface TaskWarningsProps {
  isStuck: boolean;
  isIncomplete: boolean;
  isRecovering: boolean;
  taskProgress: { completed: number; total: number };
  onRecover: () => void;
  onResume: () => void;
}

/**
 * Stuck / incomplete task: needs the user, so a vermilion left mark, the reason
 * in words and one 44px action.
 */
export function TaskWarnings({
  isStuck,
  isIncomplete,
  isRecovering,
  taskProgress,
  onRecover,
  onResume
}: TaskWarningsProps) {
  const { t } = useTranslation('tasks');
  if (!isStuck && !isIncomplete) return null;

  const stuck = isStuck;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-6 gap-y-3 border-l-[3px] border-destructive bg-muted py-2 pr-2 pl-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-destructive">
          {stuck ? t('taskDetail.warnings.stuckTitle') : t('taskDetail.warnings.incompleteTitle')}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {stuck
            ? t('taskDetail.warnings.stuckBody')
            : t('taskDetail.warnings.incompleteBody', { done: taskProgress.completed, total: taskProgress.total })}
        </p>
      </div>
      {stuck ? (
        <button
          type="button"
          onClick={onRecover}
          disabled={isRecovering}
          className="inline-flex h-11 shrink-0 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {isRecovering ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RotateCcw aria-hidden className="h-4 w-4" />}
          {isRecovering ? t('labels.recovering') : t('taskDetail.warnings.recoverRestart')}
        </button>
      ) : (
        <button
          type="button"
          onClick={onResume}
          className="inline-flex h-11 shrink-0 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Play aria-hidden className="h-4 w-4" />
          {t('taskDetail.resume')}
        </button>
      )}
    </div>
  );
}
