/**
 * The model resolved conflicts in a merge, so the commit waits here: the files
 * it wrote, and the user's decision. The state lives in git, so this comes back
 * after a restart and goes away if the merge ends in a terminal.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import type { Task } from '../../../../shared/types';

export function MergeReviewPanel({ task, onMerged }: { task: Task; onMerged?: () => void }) {
  const { t } = useTranslation('tasks');
  const [files, setFiles] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getTaskWorkspace?.(task.id, task.projectId)
      .then((r) => {
        if (!cancelled && r?.success) setFiles(r.data?.mergeReview?.files ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, task.status]);

  const decide = async (reviewAction: 'commit' | 'cancel') => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.mergeWorktree(task.id, { reviewAction });
      if (!result.success || !result.data?.success) {
        setError(result.data?.message || result.error || t('mergeReview.failed'));
        return;
      }
      setFiles(null);
      if (reviewAction === 'commit') onMerged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mergeReview.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (!files) return null;

  return (
    <section aria-labelledby="merge-review" className="border border-foreground">
      <header className="border-b border-l-2 border-b-border border-l-[var(--vt-signal)] px-4 py-3">
        <h3 id="merge-review" className="text-sm font-semibold text-foreground">{t('mergeReview.title')}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('mergeReview.description')}</p>
      </header>

      <ul className="px-4 py-2">
        {files.map((file) => (
          <li key={file} className="border-b border-border py-1.5 font-mono text-xs text-foreground last:border-b-0">{file}</li>
        ))}
      </ul>

      {error && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p>}

      <footer className="space-y-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{t('mergeReview.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void decide('commit')}>{t('mergeReview.commit')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('cancel')}>{t('mergeReview.cancel')}</Button>
        </div>
      </footer>
    </section>
  );
}
