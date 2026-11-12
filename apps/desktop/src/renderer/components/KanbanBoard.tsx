import { occupiesSlot, parallelTaskLimit, slotHolderLabels } from '../../shared/utils/task-slots';
import { isReadyToStart, nextQueuedToStart } from '../lib/task-dependencies';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useViewState } from '../contexts/ViewStateContext';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Loader2, RefreshCw, ChevronsRight, Trash2 } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { TaskCard } from './TaskCard';
import { BoardColumn } from './board/BoardColumn';
import { BulkActionBar } from './board/BulkActionBar';
import { QueueSettingsModal } from './QueueSettingsModal';
import { TASK_STATUS_COLUMNS } from '../../shared/constants';
import { cn } from '../lib/utils';
import { persistTaskStatus, forceCompleteTask, archiveTasks, deleteTasks, useTaskStore, isQueueAtCapacity } from '../stores/task-store';
import { updateProjectSettings, useProjectStore } from '../stores/project-store';
import { LooseEndsNotice } from './LooseEndsNotice';
import { useKanbanSettingsStore, DEFAULT_COLUMN_WIDTH, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, BASE_FONT_SIZE } from '../stores/kanban-settings-store';
import { useToast } from '../hooks/use-toast';
import { WorktreeCleanupDialog } from './WorktreeCleanupDialog';
import { BulkPRDialog } from './BulkPRDialog';
import { BriefImportDialog } from './brief-import';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import type { Task, TaskStatus, TaskOrderState } from '../../shared/types';

// Type guard for valid drop column targets - preserves literal type from TASK_STATUS_COLUMNS
const VALID_DROP_COLUMNS = new Set<string>(TASK_STATUS_COLUMNS);
function isValidDropColumn(id: string): id is typeof TASK_STATUS_COLUMNS[number] {
  return VALID_DROP_COLUMNS.has(id);
}

/**
 * Get the visual column for a task status.
 * pr_created tasks are displayed in the 'done' column, so we map them accordingly.
 * error tasks are displayed in the 'human_review' column (errors need human attention).
 * This is used to compare visual positions during drag-and-drop operations.
 */
function getVisualColumn(status: TaskStatus): typeof TASK_STATUS_COLUMNS[number] {
  if (status === 'pr_created') return 'done';
  if (status === 'error') return 'human_review';
  return status;
}

interface KanbanBoardProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onNewTaskClick?: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function KanbanBoard({ tasks, onTaskClick, onNewTaskClick, onRefresh, isRefreshing }: KanbanBoardProps) {
  const { t } = useTranslation(['tasks', 'dialogs', 'common']);
  const { toast } = useToast();
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const { showArchived, toggleShowArchived } = useViewState();

  // Project store for queue settings
  const projects = useProjectStore((state) => state.projects);

  // Kanban settings store for column preferences (collapse state, width, lock state)
  const columnPreferences = useKanbanSettingsStore((state) => state.columnPreferences);
  const loadKanbanPreferences = useKanbanSettingsStore((state) => state.loadPreferences);
  const saveKanbanPreferences = useKanbanSettingsStore((state) => state.savePreferences);
  const toggleColumnCollapsed = useKanbanSettingsStore((state) => state.toggleColumnCollapsed);
  const setColumnCollapsed = useKanbanSettingsStore((state) => state.setColumnCollapsed);
  const setColumnWidth = useKanbanSettingsStore((state) => state.setColumnWidth);
  const toggleColumnLocked = useKanbanSettingsStore((state) => state.toggleColumnLocked);

  // Column resize state
  const [resizingColumn, setResizingColumn] = useState<typeof TASK_STATUS_COLUMNS[number] | null>(null);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);
  // Capture projectId at resize start to avoid stale closure if project changes during resize
  const resizeProjectIdRef = useRef<string | null>(null);

  // Get projectId from first task
  const projectId = tasks[0]?.projectId;
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const maxParallelTasks = parallelTaskLimit(project?.settings?.maxParallelTasks);
  const autoMerge = project?.settings?.autoMerge === true;

  // Queue settings modal state
  const [showQueueSettings, setShowQueueSettings] = useState(false);
  // Brief import from the Planning column menu; same project choice as New Task
  const [briefImportOpen, setBriefImportOpen] = useState(false);
  const briefProjectId = useProjectStore((state) => state.activeProjectId || state.selectedProjectId);
  // A merge moves a task to done: the placeholders are read again then
  const mergedCount = tasks.filter((task) => task.status === 'done').length;
  const openBriefImport = useCallback(() => setBriefImportOpen(true), []);
  // Store projectId when modal opens to prevent modal from disappearing if tasks change
  const queueSettingsProjectIdRef = useRef<string | null>(null);

  // Queue processing lock to prevent race conditions
  const isProcessingQueueRef = useRef(false);

  // Selection state for bulk actions (Human Review column)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());

  // Bulk PR dialog state
  const [bulkPRDialogOpen, setBulkPRDialogOpen] = useState(false);

  // Delete confirmation dialog state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Worktree cleanup dialog state
  const [worktreeCleanupDialog, setWorktreeCleanupDialog] = useState<{
    open: boolean;
    taskId: string | null;
    taskTitle: string;
    worktreePath?: string;
    isProcessing: boolean;
    error?: string;
  }>({
    open: false,
    taskId: null,
    taskTitle: '',
    worktreePath: undefined,
    isProcessing: false,
    error: undefined
  });

  // Calculate archived count for Done column button
  const archivedCount = useMemo(() =>
    tasks.filter(t => t.metadata?.archivedAt).length,
    [tasks]
  );

  // Calculate collapsed column count for "Expand All" button
  const collapsedColumnCount = useMemo(() => {
    if (!columnPreferences) return 0;
    return TASK_STATUS_COLUMNS.filter(
      (status) => columnPreferences[status]?.isCollapsed
    ).length;
  }, [columnPreferences]);

  // Filter tasks based on archive status
  const filteredTasks = useMemo(() => {
    if (showArchived) {
      return tasks; // Show all tasks including archived
    }
    return tasks.filter((t) => !t.metadata?.archivedAt);
  }, [tasks, showArchived]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // 8px movement required before drag starts
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  // Get task order from store for custom ordering
  const taskOrder = useTaskStore((state) => state.taskOrder);

  const tasksByStatus = useMemo(() => {
    // Note: pr_created tasks are shown in the 'done' column since they're essentially complete
    // Note: error tasks are shown in the 'human_review' column since they need human attention
    const grouped: Record<typeof TASK_STATUS_COLUMNS[number], Task[]> = {
      backlog: [],
      queue: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: []
    };

    filteredTasks.forEach((task) => {
      // Map pr_created tasks to the done column, error tasks to human_review
      const targetColumn = getVisualColumn(task.status);
      if (grouped[targetColumn]) {
        grouped[targetColumn].push(task);
      }
    });

    // Sort tasks within each column
    Object.keys(grouped).forEach((status) => {
      const statusKey = status as typeof TASK_STATUS_COLUMNS[number];
      const columnTasks = grouped[statusKey];
      const columnOrder = taskOrder?.[statusKey];

      if (columnOrder && columnOrder.length > 0) {
        // Custom order exists: sort by order index
        // 1. Create a set of current task IDs for fast lookup (filters stale IDs)
        const currentTaskIds = new Set(columnTasks.map(t => t.id));

        // 2. Create valid order by filtering out stale IDs
        const validOrder = columnOrder.filter(id => currentTaskIds.has(id));
        const validOrderSet = new Set(validOrder);

        // 3. Find new tasks not in order (prepend at top)
        const newTasks = columnTasks.filter(t => !validOrderSet.has(t.id));
        // Sort new tasks by createdAt (newest first)
        newTasks.sort((a, b) => {
          const dateA = new Date(a.createdAt).getTime();
          const dateB = new Date(b.createdAt).getTime();
          return dateB - dateA;
        });

        // 4. Sort ordered tasks by their index in validOrder
        // Pre-compute index map for O(n) sorting instead of O(n²) with indexOf
        const indexMap = new Map(validOrder.map((id, idx) => [id, idx]));
        const orderedTasks = columnTasks
          .filter(t => validOrderSet.has(t.id))
          .sort((a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));

        // 5. Prepend new tasks at top, then ordered tasks
        grouped[statusKey] = [...newTasks, ...orderedTasks];
      } else {
        // No custom order: fallback to createdAt sort (newest first)
        grouped[statusKey].sort((a, b) => {
          const dateA = new Date(a.createdAt).getTime();
          const dateB = new Date(b.createdAt).getTime();
          return dateB - dateA;
        });
      }
    });

    return grouped;
  }, [filteredTasks, taskOrder]);

  // Prune stale IDs when tasks are deleted or filtered out
  useEffect(() => {
    const allTaskIds = new Set(filteredTasks.map(t => t.id));
    setSelectedTaskIds(prev => {
      const filtered = new Set([...prev].filter(id => allTaskIds.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [filteredTasks]);

  // Selection callbacks for bulk actions (all columns)
  const toggleTaskSelection = useCallback((taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const selectAllTasks = useCallback((columnStatus?: typeof TASK_STATUS_COLUMNS[number]) => {
    if (columnStatus) {
      // Select all in specific column
      const columnTasks = tasksByStatus[columnStatus] || [];
      const columnIds = new Set(columnTasks.map((t: Task) => t.id));
      setSelectedTaskIds(prev => new Set<string>([...prev, ...columnIds]));
    } else {
      // Select all across all columns
      const allIds = new Set(filteredTasks.map(t => t.id));
      setSelectedTaskIds(allIds);
    }
  }, [tasksByStatus, filteredTasks]);

  const deselectAllTasks = useCallback(() => {
    setSelectedTaskIds(new Set());
  }, []);

  // Get selected task objects for bulk actions
  const selectedTasks = useMemo(() => {
    return filteredTasks.filter(task => selectedTaskIds.has(task.id));
  }, [filteredTasks, selectedTaskIds]);

  // Handle opening the bulk PR dialog
  const handleOpenBulkPRDialog = useCallback(() => {
    if (selectedTaskIds.size > 0) {
      setBulkPRDialogOpen(true);
    }
  }, [selectedTaskIds.size]);

  // Handle bulk PR dialog completion - clear selection
  const handleBulkPRComplete = useCallback(() => {
    deselectAllTasks();
  }, [deselectAllTasks]);

  // Handle opening delete confirmation dialog
  const handleOpenDeleteConfirm = useCallback(() => {
    if (selectedTaskIds.size > 0) {
      setDeleteConfirmOpen(true);
    }
  }, [selectedTaskIds.size]);

  // Handle confirmed bulk delete
  const handleConfirmDelete = useCallback(async () => {
    if (selectedTaskIds.size === 0) return;

    setIsDeleting(true);
    const taskIdsToDelete = Array.from(selectedTaskIds);
    const result = await deleteTasks(taskIdsToDelete);

    setIsDeleting(false);
    setDeleteConfirmOpen(false);

    if (result.success) {
      toast({
        title: t('kanban.deleteSuccess', { count: taskIdsToDelete.length }),
      });
      deselectAllTasks();
    } else {
      toast({
        title: t('kanban.deleteError'),
        description: result.error,
        variant: 'destructive',
      });
      // Still clear selection for successfully deleted tasks
      if (result.failedIds) {
        const remainingIds = new Set(result.failedIds);
        setSelectedTaskIds(remainingIds);
      }
    }
  }, [selectedTaskIds, deselectAllTasks, toast, t]);

  const handleArchiveAll = async () => {
    // Get projectId from the first task (all tasks should have the same projectId)
    const projectId = tasks[0]?.projectId;
    if (!projectId) {
      console.error('[KanbanBoard] No projectId found');
      return;
    }

    const doneTaskIds = tasksByStatus.done.map((t) => t.id);
    if (doneTaskIds.length === 0) return;

    const result = await archiveTasks(projectId, doneTaskIds);
    if (!result.success) {
      console.error('[KanbanBoard] Failed to archive tasks:', result.error);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;

    if (!over) {
      setOverColumnId(null);
      return;
    }

    const overId = over.id as string;

    // Check if over a column
    if (isValidDropColumn(overId)) {
      setOverColumnId(overId);
      return;
    }

    // Check if over a task - get its column
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      setOverColumnId(overTask.status);
    }
  };

  /**
   * Handle status change with worktree cleanup dialog support
   * Consolidated handler that accepts an optional task object for the dialog title
   */
  const handleStatusChange = async (taskId: string, requestedStatus: TaskStatus, providedTask?: Task) => {
    const task = providedTask || tasks.find(t => t.id === taskId);
    let newStatus = requestedStatus;

    // ============================================
    // QUEUE SYSTEM: Enforce parallel task limit
    // Called from both the dropdown menu and the drag-and-drop handler.
    // Excludes the task itself from the count to handle re-entry (e.g., redundant
    // status change or race with auto-promotion). processQueue auto-promotion
    // calls persistTaskStatus directly, never this function.
    // ============================================
    if (newStatus === 'in_progress' && isQueueAtCapacity(taskId)) {
      console.log('[Queue] In Progress full, redirecting task to Queue');
      newStatus = 'queue';
    }

    const oldStatus = task?.status;
    const result = await persistTaskStatus(taskId, newStatus);

    if (!result.success) {
      if (result.worktreeExists) {
        // Show the worktree cleanup dialog
        setWorktreeCleanupDialog({
          open: true,
          taskId: taskId,
          taskTitle: task?.title || t('tasks:untitled'),
          worktreePath: result.worktreePath,
          isProcessing: false,
          error: undefined
        });
      } else {
        // Show error toast for other failures
        toast({
          title: t('common:errors.operationFailed'),
          description: result.error || t('common:errors.unknownError'),
          variant: 'destructive'
        });
      }
    }
    // Note: queue auto-promotion when a task leaves in_progress is handled by the
    // useEffect task status change listener (registerTaskStatusChangeListener), so
    // no explicit processQueue() call is needed here.
  };

  /**
   * Handle worktree cleanup confirmation
   */
  const handleWorktreeCleanupConfirm = async () => {
    if (!worktreeCleanupDialog.taskId) return;

    setWorktreeCleanupDialog(prev => ({ ...prev, isProcessing: true, error: undefined }));

    const result = await forceCompleteTask(worktreeCleanupDialog.taskId);

    if (result.success) {
      setWorktreeCleanupDialog({
        open: false,
        taskId: null,
        taskTitle: '',
        worktreePath: undefined,
        isProcessing: false,
        error: undefined
      });
    } else {
      // Keep dialog open with error state for retry - show actual error if available
      setWorktreeCleanupDialog(prev => ({
        ...prev,
        isProcessing: false,
        error: result.error || t('dialogs:worktreeCleanup.errorDescription')
      }));
    }
  };

  /**
   * Move all backlog tasks to queue
   */
  const handleQueueAll = async () => {
    const backlogTasks = tasksByStatus.backlog;
    if (backlogTasks.length === 0) return;

    let movedCount = 0;
    for (const task of backlogTasks) {
      const result = await persistTaskStatus(task.id, 'queue');
      if (result.success) {
        movedCount++;
      } else {
        console.error(`[Queue] Failed to move task ${task.id} to queue:`, result.error);
      }
    }

    // Auto-promote queued tasks to fill available capacity
    await processQueue();

    toast({
      title: t('queue.queueAllSuccess', { count: movedCount }),
      variant: 'default'
    });
  };

  /**
   * Save queue settings (maxParallelTasks, autoMerge)
   *
   * Uses the stored ref value to ensure the save works even if tasks
   * change while the modal is open.
   */
  const handleSaveQueueSettings = async (maxParallel: number, autoMergeOn: boolean, previewHoldOn: boolean) => {
    const savedProjectId = queueSettingsProjectIdRef.current || projectId;
    if (!savedProjectId) return;

    const success = await updateProjectSettings(savedProjectId, { maxParallelTasks: maxParallel, autoMerge: autoMergeOn, previewBeforeAutoMerge: previewHoldOn });
    if (success) {
      toast({
        title: t('queue.settings.saved'),
        variant: 'default'
      });
    } else {
      toast({
        title: t('queue.settings.saveFailed'),
        description: t('queue.settings.retry'),
        variant: 'destructive'
      });
    }
  };

  /**
   * Automatically move tasks from Queue to In Progress to fill available capacity
   * Promotes multiple tasks if needed (e.g., after bulk queue)
   */
  const processQueue = useCallback(async () => {
    // Prevent concurrent executions to avoid race conditions
    if (isProcessingQueueRef.current) {
      console.log('[Queue] Already processing queue, skipping duplicate call');
      return;
    }

    isProcessingQueueRef.current = true;

    try {
      // Track tasks we've already attempted to promote (to avoid infinite retries)
      const attemptedTaskIds = new Set<string>();
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 10; // Safety limit to prevent infinite loop

      // Loop until capacity is full or queue is empty
      while (true) {
        // Get CURRENT state from store to ensure accuracy
        const currentTasks = useTaskStore.getState().tasks;
        const inProgressCount = currentTasks.filter(occupiesSlot).length;
        // The oldest queued task that may start (dependencies done), if a slot is free
        const nextTask = nextQueuedToStart(currentTasks, maxParallelTasks, attemptedTaskIds);

        // Stop if no capacity, no queued tasks, or too many consecutive failures
        if (!nextTask) {
          break;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(`[Queue] Stopping queue processing after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          break;
        }

        console.log(`[Queue] Auto-promoting task ${nextTask.id} from Queue to In Progress (${inProgressCount + 1}/${maxParallelTasks})`);
        const result = await persistTaskStatus(nextTask.id, 'in_progress');

        if (result.success) {
          // Reset consecutive failures on success
          consecutiveFailures = 0;
        } else {
          // If promotion failed, log error, mark as attempted, and skip to next task
          console.error(`[Queue] Failed to promote task ${nextTask.id} to In Progress:`, result.error);
          attemptedTaskIds.add(nextTask.id);
          consecutiveFailures++;
        }
      }

      // Log if we had failed tasks
      if (attemptedTaskIds.size > 0) {
        console.warn(`[Queue] Skipped ${attemptedTaskIds.size} task(s) that failed to promote`);
      }
    } finally {
      isProcessingQueueRef.current = false;
    }
  }, [maxParallelTasks]);

  // Register task status change listener for queue auto-promotion
  // This ensures processQueue() is called whenever a task leaves in_progress
  useEffect(() => {
    const unregister = useTaskStore.getState().registerTaskStatusChangeListener(
      (taskId, oldStatus, newStatus) => {
        // When a task leaves in_progress (e.g., goes to human_review), process the queue
        if (oldStatus === 'in_progress' && newStatus !== 'in_progress') {
          console.log(`[Queue] Task ${taskId} left in_progress, processing queue to fill slot`);
          processQueue();
        } else if (newStatus === 'done' || newStatus === 'queue') {
          // A finished task may unblock queued tasks that depend on it; a task
          // that joins the queue starts at once if there is a free slot.
          processQueue();
        }
      }
    );

    // Cleanup: unregister listener when component unmounts
    return unregister;
  }, [processQueue]);

  // Tasks can arrive in the queue without a status change in this window: created
  // straight into it (spec document import), or queued before the board opened.
  // Whenever the set of startable queued tasks changes, fill the free slots.
  const readyQueuedKey = useTaskStore((state) =>
    state.tasks
      .filter((t) => t.status === 'queue' && !t.metadata?.archivedAt && isReadyToStart(t, state.tasks))
      .map((t) => t.id)
      .join(',')
  );
  // A slot also comes free without a status change: a task deleted or archived
  const slotsInUse = useTaskStore((state) => state.tasks.filter(occupiesSlot).length);
  useEffect(() => {
    if (readyQueuedKey) void processQueue();
  }, [readyQueuedKey, slotsInUse, processQueue]);

  const holderNames = useTaskStore((state) => slotHolderLabels(state.tasks, (number) => t('queue.heldForPreview', { number })).join(', '));

  // Get task order actions from store
  const reorderTasksInColumn = useTaskStore((state) => state.reorderTasksInColumn);
  const moveTaskToColumnTop = useTaskStore((state) => state.moveTaskToColumnTop);
  const saveTaskOrderToStorage = useTaskStore((state) => state.saveTaskOrder);
  const loadTaskOrder = useTaskStore((state) => state.loadTaskOrder);
  const setTaskOrder = useTaskStore((state) => state.setTaskOrder);

  const saveTaskOrder = useCallback((projectIdToSave: string) => {
    const success = saveTaskOrderToStorage(projectIdToSave);
    if (!success) {
      toast({
        title: t('kanban.orderSaveFailedTitle'),
        description: t('kanban.orderSaveFailedDescription'),
        variant: 'destructive'
      });
    }
    return success;
  }, [saveTaskOrderToStorage, toast, t]);

  // Load task order on mount and when project changes
  useEffect(() => {
    if (projectId) {
      loadTaskOrder(projectId);
    }
  }, [projectId, loadTaskOrder]);

  // Load kanban column preferences on mount and when project changes
  useEffect(() => {
    if (projectId) {
      loadKanbanPreferences(projectId);
    }
  }, [projectId, loadKanbanPreferences]);

  // Create a callback to toggle collapsed state and save to storage
  const handleToggleColumnCollapsed = useCallback((status: typeof TASK_STATUS_COLUMNS[number]) => {
    // Capture projectId at function start to avoid stale closure in setTimeout
    const currentProjectId = projectId;
    toggleColumnCollapsed(status);
    // Save preferences after toggling
    if (currentProjectId) {
      // Use setTimeout to ensure state is updated before saving
      setTimeout(() => {
        saveKanbanPreferences(currentProjectId);
      }, 0);
    }
  }, [toggleColumnCollapsed, saveKanbanPreferences, projectId]);

  // Create a callback to expand all collapsed columns and save to storage
  const handleExpandAll = useCallback(() => {
    // Capture projectId at function start to avoid stale closure in setTimeout
    const currentProjectId = projectId;
    // Expand all collapsed columns
    for (const status of TASK_STATUS_COLUMNS) {
      if (columnPreferences?.[status]?.isCollapsed) {
        setColumnCollapsed(status, false);
      }
    }
    // Save preferences after expanding
    if (currentProjectId) {
      setTimeout(() => {
        saveKanbanPreferences(currentProjectId);
      }, 0);
    }
  }, [columnPreferences, setColumnCollapsed, saveKanbanPreferences, projectId]);

  // Create a callback to toggle locked state and save to storage
  const handleToggleColumnLocked = useCallback((status: typeof TASK_STATUS_COLUMNS[number]) => {
    // Capture projectId at function start to avoid stale closure in setTimeout
    const currentProjectId = projectId;
    toggleColumnLocked(status);
    // Save preferences after toggling
    if (currentProjectId) {
      // Use setTimeout to ensure state is updated before saving
      setTimeout(() => {
        saveKanbanPreferences(currentProjectId);
      }, 0);
    }
  }, [toggleColumnLocked, saveKanbanPreferences, projectId]);

  // Resize handlers for column width adjustment
  const handleResizeStart = useCallback((status: typeof TASK_STATUS_COLUMNS[number], startX: number) => {
    const currentWidth = columnPreferences?.[status]?.width ?? DEFAULT_COLUMN_WIDTH;
    resizeStartX.current = startX;
    resizeStartWidth.current = currentWidth;
    // Capture projectId at resize start to ensure we save to the correct project
    resizeProjectIdRef.current = projectId ?? null;
    setResizingColumn(status);
  }, [columnPreferences, projectId]);

  const handleResizeMove = useCallback((clientX: number) => {
    if (!resizingColumn) return;

    const scaleFactor = parseFloat(getComputedStyle(document.documentElement).fontSize) / BASE_FONT_SIZE;
    const deltaX = (clientX - resizeStartX.current) / scaleFactor;
    const newWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, resizeStartWidth.current + deltaX));
    setColumnWidth(resizingColumn, newWidth);
  }, [resizingColumn, setColumnWidth]);

  const handleResizeEnd = useCallback(() => {
    // Use the projectId captured at resize start to avoid saving to wrong project
    const savedProjectId = resizeProjectIdRef.current;
    if (resizingColumn && savedProjectId) {
      saveKanbanPreferences(savedProjectId);
    }
    setResizingColumn(null);
    resizeProjectIdRef.current = null;
  }, [resizingColumn, saveKanbanPreferences]);

  // Document-level event listeners for resize dragging
  useEffect(() => {
    if (!resizingColumn) return;

    const handleMouseMove = (e: MouseEvent) => {
      handleResizeMove(e.clientX);
    };

    const handleMouseUp = () => {
      handleResizeEnd();
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      handleResizeMove(e.touches[0].clientX);
    };

    const handleTouchEnd = () => {
      handleResizeEnd();
    };

    // Prevent text selection and set resize cursor during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [resizingColumn, handleResizeMove, handleResizeEnd]);

  // Clean up stale task IDs from order when tasks change (e.g., after deletion)
  // This ensures the persisted order doesn't contain IDs for deleted tasks
  useEffect(() => {
    if (!projectId || !taskOrder) return;

    // Build a set of current task IDs for fast lookup
    const currentTaskIds = new Set(tasks.map(t => t.id));

    // Check each column for stale IDs
    let hasStaleIds = false;
    const cleanedOrder: typeof taskOrder = {
      backlog: [],
      queue: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: [],
      pr_created: [],
      error: []
    };

    for (const status of Object.keys(taskOrder) as Array<keyof typeof taskOrder>) {
      const columnOrder = taskOrder[status] || [];
      const cleanedColumnOrder = columnOrder.filter(id => currentTaskIds.has(id));

      cleanedOrder[status] = cleanedColumnOrder;

      // Check if any IDs were removed
      if (cleanedColumnOrder.length !== columnOrder.length) {
        hasStaleIds = true;
      }
    }

    // If stale IDs were found, update the order and persist
    if (hasStaleIds) {
      setTaskOrder(cleanedOrder);
      saveTaskOrder(projectId);
    }
  }, [tasks, taskOrder, projectId, setTaskOrder, saveTaskOrder]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    setOverColumnId(null);

    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    // Determine target status
    let newStatus: TaskStatus | null = null;
    let oldStatus: TaskStatus | null = null;

    // Get the task being dragged
    const task = tasks.find((t) => t.id === activeTaskId);
    if (!task) return;
    oldStatus = task.status;

    // Check if dropped on a column
    if (isValidDropColumn(overId)) {
      newStatus = overId;
    } else {
      // Check if dropped on another task - move to that task's column
      const overTask = tasks.find((t) => t.id === overId);
      if (overTask) {
        const task = tasks.find((t) => t.id === activeTaskId);
        if (!task) return;

        // Compare visual columns
        const taskVisualColumn = getVisualColumn(task.status);
        const overTaskVisualColumn = getVisualColumn(overTask.status);

        // Same visual column: reorder within column
        if (taskVisualColumn === overTaskVisualColumn) {
          // Ensure both tasks are in the order array before reordering
          // This handles tasks that existed before ordering was enabled
          const currentColumnOrder = taskOrder?.[taskVisualColumn] ?? [];
          const activeInOrder = currentColumnOrder.includes(activeTaskId);
          const overInOrder = currentColumnOrder.includes(overId);

          if (!activeInOrder || !overInOrder) {
            // Sync the current visual order to the stored order
            // This ensures existing tasks can be reordered
            const visualOrder = tasksByStatus[taskVisualColumn].map(t => t.id);
            setTaskOrder({
              ...taskOrder,
              [taskVisualColumn]: visualOrder
            } as TaskOrderState);
          }

          // Reorder tasks within the same column using the visual column key
          reorderTasksInColumn(taskVisualColumn, activeTaskId, overId);

          if (projectId) {
            saveTaskOrder(projectId);
          }
          return;
        }

        // Different visual column: move to that task's column (status change)
        // Use the visual column key for ordering to ensure consistency
        newStatus = overTask.status;
        moveTaskToColumnTop(activeTaskId, overTaskVisualColumn, taskVisualColumn);

        // Persist task order
        if (projectId) {
          saveTaskOrder(projectId);
        }
      }
    }

    if (!newStatus || newStatus === oldStatus) return;

    // Persist status change via handleStatusChange which enforces queue capacity,
    // handles worktree cleanup dialogs, and calls processQueue() when a task
    // leaves in_progress.
    await handleStatusChange(activeTaskId, newStatus, task);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Board toolbar: expand all (when 3+ columns are collapsed) and refresh */}
      {(onRefresh || collapsedColumnCount >= 3) && (
        <div className="flex h-11 shrink-0 items-center justify-end gap-1 px-4 pt-2">
          {collapsedColumnCount >= 3 && (
            <button
              type="button"
              onClick={handleExpandAll}
              className="inline-flex h-11 items-center gap-2 px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronsRight aria-hidden className="h-4 w-4" />
              {t('tasks:kanban.expandAll')}
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="inline-flex h-11 items-center gap-2 px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw aria-hidden className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
              {isRefreshing ? t('common:buttons.refreshing') : t('tasks:refreshTasks')}
            </button>
          )}
        </div>
      )}
      {briefProjectId && <LooseEndsNotice projectId={briefProjectId} refreshKey={mergedCount} />}
      {/* Kanban columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-h-0 flex-1 overflow-x-auto px-2 pt-2 pb-6">
          {TASK_STATUS_COLUMNS.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
              onTaskClick={onTaskClick}
              onStatusChange={handleStatusChange}
              isOver={overColumnId === status}
              onAddClick={status === 'backlog' ? onNewTaskClick : undefined}
              onImportBrief={status === 'backlog' && briefProjectId ? openBriefImport : undefined}
              onQueueAll={status === 'backlog' ? handleQueueAll : undefined}
              onQueueSettings={status === 'queue' ? () => {
                // Only open modal if we have a valid projectId
                if (!projectId) return;
                queueSettingsProjectIdRef.current = projectId;
                setShowQueueSettings(true);
              } : undefined}
              onArchiveAll={status === 'done' ? handleArchiveAll : undefined}
              maxParallelTasks={status === 'in_progress' || status === 'queue' ? maxParallelTasks : undefined}
              slotsInUse={status === 'in_progress' || status === 'queue' ? slotsInUse : undefined}
              slotHolderNames={status === 'queue' ? holderNames : undefined}
              archivedCount={status === 'done' ? archivedCount : undefined}
              showArchived={status === 'done' ? showArchived : undefined}
              onToggleArchived={status === 'done' ? toggleShowArchived : undefined}
              selectedTaskIds={selectedTaskIds}
              onSelectAll={() => selectAllTasks(status)}
              onDeselectAll={deselectAllTasks}
              onToggleSelect={toggleTaskSelection}
              isCollapsed={columnPreferences?.[status]?.isCollapsed}
              onToggleCollapsed={() => handleToggleColumnCollapsed(status)}
              columnWidth={columnPreferences?.[status]?.width}
              isResizing={resizingColumn === status}
              onResizeStart={(startX) => handleResizeStart(status, startX)}
              onResizeEnd={handleResizeEnd}
              isLocked={columnPreferences?.[status]?.isLocked}
              onToggleLocked={() => handleToggleColumnLocked(status)}
            />
          ))}
        </div>

        {/* Drag overlay - enhanced visual feedback */}
        <DragOverlay>
          {activeTask ? (
            <div className="vt-drag-overlay">
              <TaskCard task={activeTask} onClick={() => {}} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {selectedTaskIds.size > 0 && (
        <BulkActionBar
          count={selectedTaskIds.size}
          onCreatePRs={handleOpenBulkPRDialog}
          onDelete={handleOpenDeleteConfirm}
          onClear={deselectAllTasks}
        />
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="sm:max-w-[500px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              {t('kanban.deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('kanban.deleteConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Task List Preview */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('kanban.tasksToDelete')}</label>
            <ScrollArea className="h-32 rounded-md border border-border p-2">
              <div className="space-y-1">
                {selectedTasks.map((task, idx) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-muted/50"
                  >
                    <span className="text-muted-foreground">{idx + 1}.</span>
                    <span className="truncate">{task.title}</span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Warning message */}
          <p className="text-sm text-destructive">
            {t('kanban.deleteWarning')}
          </p>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('common:buttons.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common:buttons.deleting')}
                </>
              ) : (
                t('kanban.deleteConfirmButton', { count: selectedTaskIds.size })
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Worktree cleanup confirmation dialog */}
      <WorktreeCleanupDialog
        open={worktreeCleanupDialog.open}
        taskTitle={worktreeCleanupDialog.taskTitle}
        worktreePath={worktreeCleanupDialog.worktreePath}
        isProcessing={worktreeCleanupDialog.isProcessing}
        error={worktreeCleanupDialog.error}
        onOpenChange={(open) => {
          if (!open && !worktreeCleanupDialog.isProcessing) {
            setWorktreeCleanupDialog(prev => ({ ...prev, open: false, error: undefined }));
          }
        }}
        onConfirm={handleWorktreeCleanupConfirm}
      />

      {/* Queue Settings Modal */}
      {(queueSettingsProjectIdRef.current || projectId) && (
        <QueueSettingsModal
          open={showQueueSettings}
          onOpenChange={(open) => {
            setShowQueueSettings(open);
            if (!open) {
              queueSettingsProjectIdRef.current = null;
            }
          }}
          projectId={queueSettingsProjectIdRef.current || projectId || ''}
          currentMaxParallel={maxParallelTasks}
          currentAutoMerge={autoMerge}
          currentPreviewBeforeAutoMerge={project?.settings?.previewBeforeAutoMerge === true}
          onSave={handleSaveQueueSettings}
        />
      )}

      {briefProjectId && (
        <BriefImportDialog projectId={briefProjectId} open={briefImportOpen} onOpenChange={setBriefImportOpen} />
      )}

      {/* Bulk PR creation dialog */}
      <BulkPRDialog
        open={bulkPRDialogOpen}
        tasks={selectedTasks}
        onOpenChange={setBulkPRDialogOpen}
        onComplete={handleBulkPRComplete}
      />
    </div>
  );
}
