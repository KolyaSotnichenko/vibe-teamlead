/**
 * Sessions of this run that stopped at their turn limit. The work goes on in a
 * new session, so this isn't an error, but several in a row mean the task is too
 * big for one session.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task, TurnLimitHit } from '../../../shared/types';

export function TurnLimitNotice({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const [hits, setHits] = useState<TurnLimitHit[]>([]);
  const progress = task.subtasks?.filter((s) => s.status === 'completed').length ?? 0;

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getTaskWorkspace?.(task.id, task.projectId)
      .then((r) => {
        if (!cancelled && r?.success) setHits(r.data?.turnLimits ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, task.status, task.executionProgress?.phase, progress]);

  if (!hits.length) return null;

  return (
    <section aria-labelledby="turn-limit" className="border-l-2 border-l-[var(--vt-signal)] py-1 pl-4">
      <h3 id="turn-limit" className="text-sm font-semibold text-foreground">{t('turnLimit.title')}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">{t('turnLimit.body')}</p>
      <ul className="mt-1">
        {hits.map((hit) => (
          <li key={`${hit.agentType}-${hit.subtaskId ?? ''}`} className="font-mono text-xs text-muted-foreground">
            {[hit.agentType, hit.subtaskId, t('turnLimit.turns', { limit: hit.limit }), hit.count > 1 ? `×${hit.count}` : null].filter(Boolean).join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  );
}
