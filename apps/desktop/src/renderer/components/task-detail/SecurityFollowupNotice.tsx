/**
 * Findings below the bar that blocks a task went to a new task. QA's approval stands,
 * and without this they'd stay in a report nobody opens.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';

export function SecurityFollowupNotice({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const [followup, setFollowup] = useState<{ specId: string; count: number } | null>(null);
  const inReview = task.status === 'human_review';

  useEffect(() => {
    setFollowup(null);
    if (!inReview) return;
    let cancelled = false;
    window.electronAPI
      ?.getTaskSecurityFollowup?.(task.id, task.projectId)
      .then((r) => {
        if (!cancelled && r?.success) setFollowup(r.data ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, inReview, task.reviewReason]);

  if (!followup) return null;
  return (
    <section aria-labelledby="security-followup" className="border-l-2 border-l-border py-1 pl-4">
      <h3 id="security-followup" className="text-sm font-semibold text-foreground">{t('securityFollowup.title', { count: followup.count })}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">{t('securityFollowup.body')}</p>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{followup.specId}</p>
    </section>
  );
}
