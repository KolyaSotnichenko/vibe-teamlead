/**
 * The designer waiting out a rate limit or an API error before its next try (design-runner.ts),
 * on the task card and the Design tab: when it tries again and which try, with Stop waiting (the
 * design stops for the owner now, as "Design couldn't be made"). Read from the task's execution
 * progress, which the worker pushes; nothing here polls.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DesignWait, Task } from '../../../../shared/types';
import { cn } from '../../../lib/utils';

/** The designer's wait shown for a task: only while it runs */
export function designWaitOf(task: Task): DesignWait | null {
  const wait = task.executionProgress?.designWait;
  return task.status === 'in_progress' && wait ? wait : null;
}

export function DesignWaitNotice({ task, variant }: { task: Task; variant: 'card' | 'tab' }) {
  const { t, i18n } = useTranslation('tasks');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wait = designWaitOf(task);
  if (!wait) return null;
  const time = new Date(wait.until).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const text = t(`design.wait.${wait.kind}`, { time, attempt: wait.attempt, of: wait.of });

  const stop = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setBusy(true);
    const result = await window.electronAPI.design.stopDesignWait(task.id);
    setBusy(false);
    if (!result.success) setError(result.error ?? null);
  };

  const button = (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => void stop(e)}
      className={cn(
        'shrink-0 font-semibold underline underline-offset-2 hover:text-foreground disabled:opacity-60',
        variant === 'tab' && 'self-start border border-foreground px-3 py-1.5 no-underline',
      )}
    >
      {t('design.wait.stop')}
    </button>
  );

  if (variant === 'card') {
    return (
      <div role="status" className="flex min-h-11 w-full items-center gap-2 border-t border-border px-3 py-1 text-xs text-foreground">
        <span aria-hidden className="vt-breathe h-2 w-2 shrink-0 bg-foreground" />
        <span className="min-w-0 flex-1 line-clamp-2">{text}</span>
        {button}
      </div>
    );
  }
  return (
    <section role="status" className="flex flex-col gap-2 border border-foreground p-4 text-sm text-foreground">
      <p>{text}</p>
      <p className="text-xs text-muted-foreground">{t('design.wait.stopHint')}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {button}
    </section>
  );
}
