/**
 * Team status readout — the sidebar's instrument: what the agent team is doing
 * right now for the selected project. Numbers in mono, right-aligned; the only
 * vermilion is "waiting for you", and only when it is non-zero.
 */

import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useAgentQuestionsStore } from '../../stores/agent-questions-store';
import { useTaskStore } from '../../stores/task-store';

export interface TeamCounts {
  working: number;
  queued: number;
  review: number;
}

/** Exported for tests. */
export function countTeam(statuses: string[]): TeamCounts {
  let working = 0;
  let queued = 0;
  let review = 0;
  for (const status of statuses) {
    if (status === 'in_progress' || status === 'ai_review') working += 1;
    else if (status === 'queue') queued += 1;
    else if (status === 'human_review') review += 1;
  }
  return { working, queued, review };
}

export function TeamStatus({ projectId, collapsed }: { projectId: string | null; collapsed: boolean }) {
  const { t } = useTranslation('navigation');
  // Subscribe to the counts only (stable values), not to every task update.
  const counts = useTaskStore(
    useShallow((s) => countTeam(projectId ? s.tasks.filter((task) => task.projectId === projectId).map((task) => task.status) : []))
  );
  const pending = useAgentQuestionsStore((s) => s.pending);
  const openQuestion = useAgentQuestionsStore((s) => s.open);

  const waiting = pending.filter((q) => !projectId || !q.projectId || q.projectId === projectId);

  if (collapsed) {
    // Collapsed: a single mark that only appears when someone is waiting.
    return waiting.length > 0 ? (
      <button
        type="button"
        onClick={() => openQuestion(waiting[0].questionId)}
        aria-label={`${t('teamStatus.waiting')}: ${waiting.length}`}
        className="mx-auto flex h-11 w-11 items-center justify-center bg-[var(--vt-signal-text)] font-mono text-sm text-[var(--vt-paper)]"
      >
        {waiting.length}
      </button>
    ) : null;
  }

  const rows: Array<{ key: string; label: string; value: number; onClick?: () => void; alert?: boolean }> = [
    {
      key: 'waiting',
      label: t('teamStatus.waiting'),
      value: waiting.length,
      alert: waiting.length > 0,
      onClick: waiting.length > 0 ? () => openQuestion(waiting[0].questionId) : undefined,
    },
    { key: 'working', label: t('teamStatus.working'), value: counts.working },
    { key: 'queued', label: t('teamStatus.queued'), value: counts.queued },
    { key: 'review', label: t('teamStatus.review'), value: counts.review },
  ];
  const idle = rows.every((row) => row.value === 0);

  return (
    <section aria-label={t('teamStatus.title')} className="mx-3 border border-border">
      <h2 className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{t('teamStatus.title')}</h2>
      {idle ? (
        <p className="px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{t('teamStatus.idle')}</p>
      ) : (
        <div>
          {rows.map((row, index) => {
            const content = (
              <>
                <span className="flex items-center gap-2">
                  {row.alert && <span aria-hidden className="h-2 w-2 bg-[var(--vt-signal-on-dark)] vt-breathe" />}
                  {row.label}
                </span>
                <span className="font-mono tabular-nums">{row.value}</span>
              </>
            );
            const className = cn(
              'flex min-h-9 w-full items-center justify-between px-3 text-sm',
              index > 0 && 'border-t border-border',
              row.alert ? 'text-[var(--vt-signal-on-dark)]' : row.value === 0 ? 'text-muted-foreground' : 'text-foreground',
            );
            return row.onClick ? (
              <button key={row.key} type="button" onClick={row.onClick} className={cn(className, 'hover:bg-accent')}>
                {content}
              </button>
            ) : (
              <div key={row.key} className={className}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
