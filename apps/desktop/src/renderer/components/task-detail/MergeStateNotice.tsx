/**
 * A merge going on, or why the last one failed. The window that started it may be
 * long closed by now. A merge waiting for the user has its own panel.
 */

import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import { useMergeState } from './useMergeState';

export function MergeStateNotice({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const merge = useMergeState(task);

  if (merge?.state === 'merging') {
    return (
      <section aria-labelledby="merge-state" className="border-l-2 border-l-border py-1 pl-4">
        <h3 id="merge-state" className="text-sm font-semibold text-foreground">{t('mergeState.mergingTitle')}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('mergeState.mergingBody')}</p>
      </section>
    );
  }
  if (merge?.state === 'failed') {
    return (
      <section aria-labelledby="merge-state" className="border-l-2 border-l-[var(--vt-signal)] py-1 pl-4">
        <h3 id="merge-state" className="text-sm font-semibold text-foreground">{t('mergeState.failedTitle')}</h3>
        <p className="mt-1 break-words text-sm text-muted-foreground">{merge.reason}</p>
      </section>
    );
  }
  return null;
}
