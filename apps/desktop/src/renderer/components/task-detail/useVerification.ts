/** What the app's own checks found for this task, once it reaches review. */

import { useEffect, useState } from 'react';
import type { Task } from '../../../shared/types';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';

const CHANGED = 'vibe-teamlead:verification-changed';

/** The checks of a task ran again (Check again): every view of its summary reads it anew */
export function verificationChanged(taskId: string): void {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { taskId } }));
}

export function useVerification(task: Task): VerificationSummary | null {
  const [summary, setSummary] = useState<VerificationSummary | null>(null);
  const [version, setVersion] = useState(0);
  const inReview = task.status === 'human_review';

  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ taskId?: string }>).detail?.taskId === task.id) setVersion((n) => n + 1);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => window.removeEventListener(CHANGED, onChanged);
  }, [task.id]);

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
  }, [task.id, task.projectId, inReview, task.reviewReason, version]);

  return summary;
}
