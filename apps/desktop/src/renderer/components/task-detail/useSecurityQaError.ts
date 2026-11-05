/**
 * Why this task's pentest did not finish, while the task waits for review: QA has
 * approved it by then, so this is the one place the gap can still be noticed.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../../../shared/types';

export function useSecurityQaError(task: Task): { reason?: string } | null {
  const [error, setError] = useState<{ reason?: string } | null>(null);
  const inReview = task.status === 'human_review';

  useEffect(() => {
    setError(null);
    if (!inReview) return;
    let cancelled = false;
    window.electronAPI
      ?.getTaskSecurityQaError?.(task.id, task.projectId)
      .then((r) => {
        if (!cancelled && r?.success) setError(r.data ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, inReview, task.reviewReason]);

  return error;
}
