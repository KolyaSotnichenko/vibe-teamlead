/**
 * One menu per column for the rarely used column actions (collapse, width lock,
 * select all, queue all, queue settings, archive). Design system dropdown:
 * 1px ink frame, rows ≥44px separated by hairlines, checked rows show a tick.
 */

import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

const ROW = 'min-h-11 rounded-none border-b border-border pr-3 pl-8 text-sm last:border-b-0 focus:bg-primary focus:text-primary-foreground';

export interface ColumnMenuProps {
  columnLabel: string;
  taskCount: number;
  onCollapse?: () => void;
  isLocked?: boolean;
  onToggleLocked?: () => void;
  selectAllState?: boolean | 'indeterminate';
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  onQueueAll?: () => void;
  onQueueSettings?: () => void;
  onArchiveAll?: () => void;
  archivedCount?: number;
  showArchived?: boolean;
  onToggleArchived?: () => void;
}

export function ColumnMenu({
  columnLabel,
  taskCount,
  onCollapse,
  isLocked,
  onToggleLocked,
  selectAllState,
  onSelectAll,
  onDeselectAll,
  onQueueAll,
  onQueueSettings,
  onArchiveAll,
  archivedCount,
  showArchived,
  onToggleArchived,
}: ColumnMenuProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const allSelected = selectAllState === true;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('tasks:board.columnMenu', { column: columnLabel })}
          className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
        >
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60 rounded-none border-foreground p-0">
        {onQueueAll && taskCount > 0 && (
          <DropdownMenuItem className={ROW} onSelect={onQueueAll}>
            {t('tasks:queue.queueAll')}
          </DropdownMenuItem>
        )}
        {onQueueSettings && (
          <DropdownMenuItem className={ROW} onSelect={onQueueSettings}>
            {t('tasks:kanban.queueSettings')}
          </DropdownMenuItem>
        )}
        {onArchiveAll && taskCount > 0 && !showArchived && (
          <DropdownMenuItem className={ROW} onSelect={onArchiveAll}>
            {t('tasks:tooltips.archiveAllDone')}
          </DropdownMenuItem>
        )}
        {onToggleArchived && archivedCount !== undefined && archivedCount > 0 && (
          <DropdownMenuCheckboxItem className={ROW} checked={!!showArchived} onCheckedChange={onToggleArchived}>
            <span className="flex flex-1 items-center justify-between gap-3">
              {t('tasks:kanban.showArchived')}
              <span className="font-mono text-xs tabular-nums opacity-70">{archivedCount}</span>
            </span>
          </DropdownMenuCheckboxItem>
        )}
        {onSelectAll && onDeselectAll && (
          <DropdownMenuItem className={ROW} disabled={taskCount === 0} onSelect={allSelected ? onDeselectAll : onSelectAll}>
            {allSelected ? t('tasks:kanban.deselectAll') : t('tasks:kanban.selectAll')}
          </DropdownMenuItem>
        )}
        {onToggleLocked && (
          <DropdownMenuCheckboxItem className={ROW} checked={!!isLocked} onCheckedChange={onToggleLocked}>
            {t('tasks:board.lockWidth')}
          </DropdownMenuCheckboxItem>
        )}
        {onCollapse && (
          <DropdownMenuItem className={ROW} onSelect={onCollapse}>
            {t('tasks:kanban.collapseColumn')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
