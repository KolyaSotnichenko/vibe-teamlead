/** What the app's own checks found for this task, once it reaches review. */

import { useEffect, useState } from 'react';
import type { Task } from '../../../shared/types';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';

export function useVerification(task: Task): VerificationSummary | null {
  const [summary, setSummary] = useState<VerificationSummary | null>(null);
  const inReview = task.status === 'human_review';

  useEffect(() => {
    setSummary(null);
    if (!inReview) return;
    let cancelled = false;
    window.electronAPI
      ?.getTaskVerification?.(task.id, task.projectId)
      .then((r) => {
        if (!cancelled && r?.success) setSummary(r.data ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, inReview, task.reviewReason]);

  return summary;
}
