/**
 * A board column: header (name, count, add, one menu), a 1px ink rule, the cards.
 * No box around the column — columns are separated by a hairline.
 */

import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronRight, Plus } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { SortableTaskCard } from '../SortableTaskCard';
import { TASK_STATUS_LABELS } from '../../../shared/constants';
import { cn } from '../../lib/utils';
import { COLLAPSED_COLUMN_WIDTH_REM, MAX_COLUMN_WIDTH_REM, MIN_COLUMN_WIDTH_REM, pxToRem } from '../../stores/kanban-settings-store';
import type { Task, TaskStatus } from '../../../shared/types';
import { ColumnMenu } from './ColumnMenu';

export interface BoardColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, newStatus: TaskStatus) => unknown;
  isOver: boolean;
  onAddClick?: () => void;
  onArchiveAll?: () => void;
  onQueueSettings?: () => void;
  onQueueAll?: () => void;
  maxParallelTasks?: number;
  archivedCount?: number;
  showArchived?: boolean;
  onToggleArchived?: () => void;
  // Selection (bulk actions)
  selectedTaskIds?: Set<string>;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  onToggleSelect?: (taskId: string) => void;
  // Collapse
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  // Resize
  columnWidth?: number;
  isResizing?: boolean;
  onResizeStart?: (startX: number) => void;
  onResizeEnd?: () => void;
  // Lock
  isLocked?: boolean;
  onToggleLocked?: () => void;
}

/** Tasks are equivalent for rendering when ids and the fields cards show did not change. */
function tasksAreEquivalent(prevTasks: Task[], nextTasks: Task[]): boolean {
  if (prevTasks.length !== nextTasks.length) return false;
  if (prevTasks === nextTasks) return true;
  for (let i = 0; i < prevTasks.length; i++) {
    const prev = prevTasks[i];
    const next = nextTasks[i];
    if (
      prev.id !== next.id ||
      prev.status !== next.status ||
      prev.executionProgress?.phase !== next.executionProgress?.phase ||
      prev.updatedAt !== next.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

const SHALLOW_KEYS: Array<keyof BoardColumnProps> = [
  'status', 'isOver', 'onTaskClick', 'onStatusChange', 'onAddClick', 'onArchiveAll', 'onQueueSettings', 'onQueueAll',
  'maxParallelTasks', 'archivedCount', 'showArchived', 'onToggleArchived', 'onSelectAll', 'onDeselectAll', 'onToggleSelect',
  'isCollapsed', 'onToggleCollapsed', 'columnWidth', 'isResizing', 'onResizeStart', 'onResizeEnd', 'isLocked', 'onToggleLocked',
];

function boardColumnPropsAreEqual(prevProps: BoardColumnProps, nextProps: BoardColumnProps): boolean {
  for (const key of SHALLOW_KEYS) {
    if (prevProps[key] !== nextProps[key]) return false;
  }
  const prevSelected = prevProps.selectedTaskIds;
  const nextSelected = nextProps.selectedTaskIds;
  if (prevSelected !== nextSelected) {
    if (!prevSelected || !nextSelected) return false;
    if (prevSelected.size !== nextSelected.size) return false;
    for (const id of prevSelected) {
      if (!nextSelected.has(id)) return false;
    }
  }
  return tasksAreEquivalent(prevProps.tasks, nextProps.tasks);
}

const EMPTY_KEYS: Partial<Record<TaskStatus, [string, string]>> = {
  backlog: ['kanban.emptyBacklog', 'kanban.emptyBacklogHint'],
  queue: ['kanban.emptyQueue', 'kanban.emptyQueueHint'],
  in_progress: ['kanban.emptyInProgress', 'kanban.emptyInProgressHint'],
  ai_review: ['kanban.emptyAiReview', 'kanban.emptyAiReviewHint'],
  human_review: ['kanban.emptyHumanReview', 'kanban.emptyHumanReviewHint'],
  done: ['kanban.emptyDone', 'kanban.emptyDoneHint'],
};

export const BoardColumn = memo(function BoardColumn({
  status,
  tasks,
  onTaskClick,
  onStatusChange,
  isOver,
  onAddClick,
  onArchiveAll,
  onQueueSettings,
  onQueueAll,
  maxParallelTasks,
  archivedCount,
  showArchived,
  onToggleArchived,
  selectedTaskIds,
  onSelectAll,
  onDeselectAll,
  onToggleSelect,
  isCollapsed,
  onToggleCollapsed,
  columnWidth,
  isResizing,
  onResizeStart,
  onResizeEnd,
  isLocked,
  onToggleLocked,
}: BoardColumnProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { setNodeRef } = useDroppable({ id: status });
  const label = t(TASK_STATUS_LABELS[status]);

  const taskCount = tasks.length;
  const columnSelectedCount = tasks.filter((task) => selectedTaskIds?.has(task.id)).length;
  const isAllSelected = taskCount > 0 && columnSelectedCount === taskCount;
  const selectAllState: boolean | 'indeterminate' = isAllSelected ? true : columnSelectedCount > 0 ? 'indeterminate' : false;

  const handleDeselectColumn = useCallback(() => onDeselectAll?.(), [onDeselectAll]);

  const taskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);

  // Stable per-task handlers so cards do not re-render needlessly
  const onClickHandlers = useMemo(() => {
    const handlers = new Map<string, () => void>();
    for (const task of tasks) handlers.set(task.id, () => onTaskClick(task));
    return handlers;
  }, [tasks, onTaskClick]);

  const onStatusChangeHandlers = useMemo(() => {
    const handlers = new Map<string, (newStatus: TaskStatus) => unknown>();
    for (const task of tasks) handlers.set(task.id, (newStatus: TaskStatus) => onStatusChange(task.id, newStatus));
    return handlers;
  }, [tasks, onStatusChange]);

  const onToggleSelectHandlers = useMemo(() => {
    if (!onToggleSelect) return null;
    const handlers = new Map<string, () => void>();
    for (const task of tasks) handlers.set(task.id, () => onToggleSelect(task.id));
    return handlers;
  }, [tasks, onToggleSelect]);

  const taskCards = useMemo(() => {
    if (tasks.length === 0) return null;
    const isSelectable = !!onToggleSelectHandlers;
    return tasks.map((task) => (
      <SortableTaskCard
        key={task.id}
        task={task}
        onClick={onClickHandlers.get(task.id) ?? (() => onTaskClick(task))}
        onStatusChange={onStatusChangeHandlers.get(task.id)}
        isSelectable={isSelectable}
        isSelected={isSelectable ? selectedTaskIds?.has(task.id) : undefined}
        onToggleSelect={onToggleSelectHandlers?.get(task.id)}
      />
    ));
  }, [tasks, onClickHandlers, onStatusChangeHandlers, onToggleSelectHandlers, selectedTaskIds, onTaskClick]);

  const atCapacity = status === 'in_progress' && !!maxParallelTasks && tasks.length >= maxParallelTasks;

  // Collapsed: a narrow strip with the name running vertically and the count
  if (isCollapsed) {
    return (
      <section
        ref={setNodeRef}
        aria-label={label}
        className={cn('flex shrink-0 flex-col border-l border-border first:border-l-0', isOver && 'bg-accent')}
        style={{ width: COLLAPSED_COLUMN_WIDTH_REM, minWidth: COLLAPSED_COLUMN_WIDTH_REM, maxWidth: COLLAPSED_COLUMN_WIDTH_REM }}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={`${t('kanban.expandColumn')}: ${label}`}
          className="flex h-11 w-full items-center justify-center border-b border-foreground text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
        <div className="flex flex-1 justify-center pt-4">
          <div className="flex items-center gap-3 whitespace-nowrap" style={{ writingMode: 'vertical-rl' }}>
            <h2 className="text-[13px] font-semibold text-foreground">{label}</h2>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
          </div>
        </div>
      </section>
    );
  }

  const empty = EMPTY_KEYS[status] ?? ['kanban.emptyDefault', ''];

  return (
    <section
      aria-label={label}
      className="relative flex shrink-0 border-l border-border px-4 first:border-l-0"
      style={columnWidth ? { width: pxToRem(columnWidth), minWidth: MIN_COLUMN_WIDTH_REM, maxWidth: MAX_COLUMN_WIDTH_REM } : undefined}
    >
      <div ref={setNodeRef} className={cn('flex min-w-0 flex-1 flex-col', !columnWidth && 'w-80')}>
        {/* Header */}
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-foreground">
          <h2 className="truncate text-[13px] font-semibold text-foreground">{label}</h2>
          {status === 'in_progress' && maxParallelTasks ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              <span aria-hidden="true">
                {tasks.length}/{maxParallelTasks}
              </span>
              <span className="sr-only">{t('board.slots', { count: tasks.length, max: maxParallelTasks })}</span>
              {atCapacity && <span className="ml-2 bg-accent px-1 py-0.5 font-sans text-[11px] text-foreground">{t('board.full')}</span>}
            </span>
          ) : (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
          )}
          {columnSelectedCount > 0 && (
            <span className="font-mono text-[11px] text-foreground">{t('board.selectedInColumn', { count: columnSelectedCount })}</span>
          )}
          <span className="flex-1" />
          {status === 'backlog' && onAddClick && (
            <button
              type="button"
              onClick={onAddClick}
              aria-label={t('kanban.addTaskAriaLabel')}
              className="flex h-11 w-11 items-center justify-center text-foreground hover:bg-accent"
            >
              <Plus aria-hidden className="h-4 w-4" />
            </button>
          )}
          <ColumnMenu
            columnLabel={label}
            taskCount={taskCount}
            onCollapse={onToggleCollapsed}
            isLocked={isLocked}
            onToggleLocked={onToggleLocked}
            selectAllState={selectAllState}
            onSelectAll={onSelectAll}
            onDeselectAll={handleDeselectColumn}
            onQueueAll={onQueueAll}
            onQueueSettings={onQueueSettings}
            onArchiveAll={onArchiveAll}
            archivedCount={archivedCount}
            showArchived={showArchived}
            onToggleArchived={onToggleArchived}
          />
        </header>

        {/* Cards */}
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
            <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
              <div className={cn('min-h-[120px] space-y-2 py-3', isOver && tasks.length > 0 && 'bg-accent/60')}>
                {tasks.length === 0 ? (
                  <div
                    className={cn(
                      'border border-dashed px-4 py-5',
                      isOver ? 'border-foreground bg-accent' : 'border-border'
                    )}
                  >
                    {isOver ? (
                      <p className="text-sm font-semibold text-foreground">{t('kanban.dropHere')}</p>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-foreground">{t(empty[0])}</p>
                        {empty[1] && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(empty[1])}</p>}
                      </>
                    )}
                  </div>
                ) : (
                  taskCards
                )}
              </div>
            </SortableContext>
          </ScrollArea>
        </div>
      </div>

      {/* Resize handle on the right edge */}
      {onResizeStart && onResizeEnd && (
        <div
          className={cn(
            'absolute top-0 right-0 bottom-0 z-10 w-1 touch-none transition-colors duration-150',
            isLocked ? 'cursor-not-allowed' : 'cursor-col-resize hover:bg-foreground/30',
            isResizing && !isLocked && 'bg-foreground/50'
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            if (isLocked) return;
            onResizeStart(e.clientX);
          }}
          onTouchStart={(e) => {
            e.preventDefault();
            if (isLocked) return;
            if (e.touches.length > 0) onResizeStart(e.touches[0].clientX);
          }}
          title={isLocked ? t('kanban.columnLocked') : undefined}
        >
          <div className="absolute inset-y-0 -right-1 -left-1" />
        </div>
      )}
    </section>
  );
}, boardColumnPropsAreEqual);
