/**
 * Subtask progress: the count, the segmented bar, and the first rows of the plan
 * (the one in progress first), each with its status as glyph + word.
 */

import { useTranslation } from 'react-i18next';
import type { Subtask, Task } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { SubtaskBar } from '../../board/StageMarks';
import { countSubtasks } from '../../board/task-stage';
import { EmptyState, SectionHeader, SubtaskStatusLabel } from '../workspace/workspace-ui';

const VISIBLE = 6;

/** Rows to show: in-progress and failed first, then the plan order. Exported for tests. */
export function pickSubtasks(subtasks: Subtask[], limit = VISIBLE): Subtask[] {
  const urgent = subtasks.filter((s) => s.status === 'in_progress' || s.status === 'failed');
  const rest = subtasks.filter((s) => s.status !== 'in_progress' && s.status !== 'failed');
  return [...urgent, ...rest].slice(0, limit);
}

export function OverviewSubtasks({ task, onOpenAll, onOpenPlan }: { task: Task; onOpenAll: () => void; onOpenPlan: () => void }) {
  const { t } = useTranslation('tasks');
  const counts = countSubtasks(task);
  const link =
    '-mb-1 inline-flex h-8 items-center px-2 text-sm font-medium text-foreground underline-offset-2 hover:underline';

  return (
    <section aria-labelledby="overview-subtasks">
      <SectionHeader
        id="overview-subtasks"
        title={t('overview.subtasks.title')}
        action={
          counts.total > 0 ? (
            <button type="button" onClick={onOpenPlan} className={link}>
              {t('overview.subtasks.openPlan')}
            </button>
          ) : undefined
        }
      />
      {counts.total === 0 ? (
        <div className="mt-3">
          <EmptyState compact title={t('overview.subtasks.emptyTitle')} body={t('overview.subtasks.emptyBody')} />
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-end gap-4">
            <p className="font-mono text-[28px] leading-none font-medium tabular-nums text-foreground">
              {counts.done}
              <span className="text-muted-foreground">/{counts.total}</span>
            </p>
            <p className="pb-0.5 text-xs text-muted-foreground">
              {t('overview.subtasks.summary', { done: counts.done, total: counts.total })}
              {counts.failed > 0 && (
                <span className="ml-2 font-semibold text-destructive">{t('overview.subtasks.failed', { count: counts.failed })}</span>
              )}
            </p>
          </div>
          <SubtaskBar subtasks={task.subtasks} className="mt-3 h-1.5" />
          <ul className="mt-3">
            {pickSubtasks(task.subtasks).map((s) => (
              <li key={s.id} className="flex min-h-10 items-center gap-4 border-b border-border py-2">
                <span className="w-24 shrink-0">
                  <SubtaskStatusLabel status={s.status} />
                </span>
                <span className={cn('min-w-0 flex-1 truncate text-sm', s.status === 'completed' ? 'text-muted-foreground' : 'text-foreground')}>
                  {s.title || t('subtasks.untitled')}
                </span>
                {s.files.length > 0 && (
                  <span className="hidden max-w-[40%] truncate font-mono text-[11px] text-muted-foreground sm:block">{s.files[0]}</span>
                )}
              </li>
            ))}
          </ul>
          {counts.total > VISIBLE && (
            <button type="button" onClick={onOpenAll} className={cn(link, 'mt-2 h-11 px-0')}>
              {t('overview.subtasks.showAll', { count: counts.total })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
