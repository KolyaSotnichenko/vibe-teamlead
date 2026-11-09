import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RotateCcw, Loader2, SkipForward, MessageSquare } from 'lucide-react';

/** A subtask the coder marked failed or blocked, with what it wrote about why. */
export interface GaveUpSubtask {
  id: string;
  title: string;
  notes?: string;
}

/** The task's subtasks the coder gave up on (failed or blocked). Pure. */
export function gaveUpSubtasks(subtasks: Array<{ id: string; title?: string; status: string; notes?: string }> = []): GaveUpSubtask[] {
  return subtasks
    .filter((s) => s.status === 'failed' || s.status === 'blocked')
    .map((s) => ({ id: s.id, title: s.title ?? '', notes: s.notes }));
}

interface TaskWarningsProps {
  isStuck: boolean;
  isIncomplete: boolean;
  isRecovering: boolean;
  taskProgress: { completed: number; total: number };
  onRecover: () => void;
  onResume: () => void;
  /** Subtasks the coder gave up on: resuming as is would stop at them again */
  gaveUp?: GaveUpSubtask[];
  onSkipFailed?: () => void;
  onRetryFailed?: (instruction: string) => void;
  /** A decision is being saved */
  isDeciding?: boolean;
}

const PRIMARY = 'inline-flex h-11 shrink-0 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60';
const SECONDARY = 'inline-flex h-11 shrink-0 items-center gap-2 border border-foreground px-4 text-sm font-medium text-foreground hover:bg-background disabled:opacity-60';

/**
 * Stuck / incomplete task: needs the user, so a vermilion left mark, the reason
 * in words and the actions that can help. When the coder gave up on a subtask and
 * wrote why, resuming as is would stop again: the owner reads the reason and either
 * goes on without it or sends it back with an instruction.
 */
export function TaskWarnings({
  isStuck,
  isIncomplete,
  isRecovering,
  taskProgress,
  onRecover,
  onResume,
  gaveUp = [],
  onSkipFailed,
  onRetryFailed,
  isDeciding = false,
}: TaskWarningsProps) {
  const { t } = useTranslation('tasks');
  const [writing, setWriting] = useState(false);
  const [instruction, setInstruction] = useState('');
  if (!isStuck && !isIncomplete) return null;

  if (!isStuck && gaveUp.length > 0 && onSkipFailed && onRetryFailed) {
    return (
      <div role="alert" className="border-l-[3px] border-destructive bg-muted py-2 pr-2 pl-4">
        {gaveUp.map((subtask) => (
          <div key={subtask.id} className="mb-2">
            <p className="text-sm font-semibold text-destructive">{t('taskDetail.warnings.gaveUpTitle', { title: subtask.title || subtask.id })}</p>
            <p className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
              {subtask.notes?.trim() || t('taskDetail.warnings.noReason')}
            </p>
          </div>
        ))}
        <p className="text-sm text-muted-foreground">{t('taskDetail.warnings.gaveUpBody')}</p>
        {writing ? (
          <div className="mt-3 space-y-2">
            <label htmlFor="owner-instruction" className="block text-sm font-medium text-foreground">
              {t('taskDetail.warnings.instructionLabel')}
            </label>
            <textarea
              id="owner-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder={t('taskDetail.warnings.instructionPlaceholder')}
              className="w-full border border-border bg-background p-2 text-sm text-foreground"
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} disabled={isDeciding || !instruction.trim()} onClick={() => onRetryFailed(instruction.trim())}>
                {isDeciding ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Play aria-hidden className="h-4 w-4" />}
                {t('taskDetail.warnings.sendBack')}
              </button>
              <button type="button" className={SECONDARY} disabled={isDeciding} onClick={() => setWriting(false)}>
                {t('taskDetail.warnings.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} disabled={isDeciding} onClick={onSkipFailed}>
              {isDeciding ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <SkipForward aria-hidden className="h-4 w-4" />}
              {t('taskDetail.warnings.skipFailed')}
            </button>
            <button type="button" className={SECONDARY} disabled={isDeciding} onClick={() => setWriting(true)}>
              <MessageSquare aria-hidden className="h-4 w-4" />
              {t('taskDetail.warnings.retryFailed')}
            </button>
          </div>
        )}
      </div>
    );
  }

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
          className={PRIMARY}
        >
          {isRecovering ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RotateCcw aria-hidden className="h-4 w-4" />}
          {isRecovering ? t('labels.recovering') : t('taskDetail.warnings.recoverRestart')}
        </button>
      ) : (
        <button
          type="button"
          onClick={onResume}
          className={PRIMARY}
        >
          <Play aria-hidden className="h-4 w-4" />
          {t('taskDetail.resume')}
        </button>
      )}
    </div>
  );
}
