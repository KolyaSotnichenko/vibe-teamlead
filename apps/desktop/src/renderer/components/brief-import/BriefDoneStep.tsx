/**
 * Step 4: what was created, with the spec ids the main process returned.
 */

import { useTranslation } from 'react-i18next';
import type { BriefCreatedTask } from '../../../shared/types';
import { Notice } from '../task-detail/workspace/workspace-ui';

export function BriefDoneStep({
  created,
  titles,
  queued,
}: {
  created: BriefCreatedTask[];
  /** Title per proposal key, as sent */
  titles: ReadonlyMap<string, string>;
  queued: boolean;
}) {
  const { t } = useTranslation(['tasks']);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div role="status" className="space-y-2">
        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          <span aria-hidden className="h-2 w-2 bg-foreground" />
          {t('tasks:briefImport.done.label')}
        </p>
        <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
          {t('tasks:briefImport.done.title', { count: created.length })}
        </h3>
      </div>
      <Notice>{queued ? t('tasks:briefImport.done.queued') : t('tasks:briefImport.done.planning')}</Notice>
      <ol className="border border-foreground">
        {created.map((task) => (
          <li key={task.taskId} className="flex min-h-11 items-center gap-4 border-b border-border px-4 py-2 last:border-b-0">
            <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">{task.key}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{titles.get(task.key) ?? task.key}</span>
            <span className="shrink-0 font-mono text-xs text-foreground">{task.specId}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
