/**
 * Bulk actions for selected cards: a 1px ink frame docked at the bottom,
 * 44px buttons separated by hairlines.
 */

import { useTranslation } from 'react-i18next';
import { GitPullRequest, Trash2, X } from 'lucide-react';

export function BulkActionBar({
  count,
  onCreatePRs,
  onDelete,
  onClear,
}: {
  count: number;
  onCreatePRs: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation(['tasks']);
  const button =
    'inline-flex h-11 items-center gap-2 border-l border-border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2';
  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <div role="toolbar" aria-label={t('kanban.selectedCountOther', { count })} className="flex items-stretch border border-foreground bg-card text-card-foreground">
        <span className="inline-flex h-11 items-center px-4 text-sm text-foreground">
          <span className="mr-1.5 font-mono tabular-nums">{count}</span>
          {t('board.selected', { count })}
        </span>
        <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} onClick={onCreatePRs}>
          <GitPullRequest aria-hidden className="h-4 w-4" />
          {t('kanban.createPRs')}
        </button>
        <button type="button" className={`${button} text-foreground hover:bg-accent`} onClick={onDelete}>
          <Trash2 aria-hidden className="h-4 w-4" />
          {t('kanban.deleteSelected')}
        </button>
        <button type="button" className={`${button} text-muted-foreground hover:bg-accent hover:text-foreground`} onClick={onClear}>
          <X aria-hidden className="h-4 w-4" />
          {t('kanban.clearSelection')}
        </button>
      </div>
    </div>
  );
}
