/**
 * Board card: one task as an instrument readout.
 *
 *   ┌────────────────────────────────────┐
 *   │ □  ■■■▣□□  Coder   Dashboard layout │  stage ticks + who is working
 *   │ Build analytics dashboard           │  title
 *   │ ▬▬ ▬▬ ▭▭ ▭▭                   2/4   │  subtasks
 *   │ ■ Waiting for you          Answer   │  only when an agent asks (vermilion)
 *   ├────────────────────────────────────┤
 *   │ HIGH  4 min ago  worktree           │  meta row
 *   │ ■ Preview ↗               built 2m  │  preview row (when there is one)
 *   ├────────────────────────────────────┤
 *   │ ▶ Start                         │ ⋮ │  44px action strip, buttons only
 *   └────────────────────────────────────┘
 *
 * Everything shown comes from the Task object; nothing is estimated.
 */

import { useState, useEffect, useRef, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2, RotateCcw, Archive, GitPullRequest, MoreVertical } from 'lucide-react';
import { selectTaskQuestion, useAgentQuestionsStore } from '../stores/agent-questions-store';
import { Checkbox } from './ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn, sanitizeMarkdownForDisplay } from '../lib/utils';
import {
  TASK_STATUS_COLUMNS,
  TASK_STATUS_LABELS,
  JSON_ERROR_PREFIX,
  JSON_ERROR_TITLE_SUFFIX
} from '../../shared/constants';
import { stopTask, checkTaskRunning, recoverStuckTask, isIncompleteHumanReview, archiveTasks, hasRecentActivity, startTaskOrQueue } from '../stores/task-store';
import { useToast } from '../hooks/use-toast';
import type { Task, TaskStatus } from '../../shared/types';
import { StageTicks, SubtaskBar } from './board/StageMarks';
import { countSubtasks, formatSince, getTaskStage, type TaskStageInfo } from './board/task-stage';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useMergeState } from './task-detail/useMergeState';
import { useVerification } from './task-detail/useVerification';
import { useSecurityQaError } from './task-detail/useSecurityQaError';
import { usePreview } from './task-detail/usePreview';
import { formatRelative, isHttpsUrl, openWebUrl } from './deploy/status';
import type { DeployTarget } from '../../shared/types/deploy';

// Catastrophic stuck detection interval (ms).
// XState handles all normal process-exit transitions via PROCESS_EXITED events.
// This is a last-resort safety net: if XState somehow fails to transition the task
// out of in_progress after the process dies, flag it as stuck after 60 seconds.
const STUCK_CHECK_INTERVAL_MS = 60_000;

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange?: (newStatus: TaskStatus) => unknown;
  // Optional selectable mode props for multi-selection
  isSelectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

// Custom comparator for React.memo - only re-render when relevant task data changes
function taskCardPropsAreEqual(prevProps: TaskCardProps, nextProps: TaskCardProps): boolean {
  const prevTask = prevProps.task;
  const nextTask = nextProps.task;

  // Fast path: same reference (include selectable props)
  if (
    prevTask === nextTask &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.onStatusChange === nextProps.onStatusChange &&
    prevProps.isSelectable === nextProps.isSelectable &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.onToggleSelect === nextProps.onToggleSelect
  ) {
    return true;
  }

  // Check selectable props first (cheap comparison)
  if (
    prevProps.isSelectable !== nextProps.isSelectable ||
    prevProps.isSelected !== nextProps.isSelected
  ) {
    return false;
  }

  // Compare only the fields that affect rendering
  return (
    prevTask.id === nextTask.id &&
    prevTask.status === nextTask.status &&
    prevTask.title === nextTask.title &&
    prevTask.description === nextTask.description &&
    prevTask.updatedAt === nextTask.updatedAt &&
    prevTask.reviewReason === nextTask.reviewReason &&
    prevTask.waitingForPreview === nextTask.waitingForPreview &&
    prevTask.location === nextTask.location &&
    prevTask.executionProgress?.phase === nextTask.executionProgress?.phase &&
    prevTask.executionProgress?.message === nextTask.executionProgress?.message &&
    prevTask.executionProgress?.currentSubtask === nextTask.executionProgress?.currentSubtask &&
    prevTask.executionProgress?.completedPhases?.length === nextTask.executionProgress?.completedPhases?.length &&
    (prevTask.executionProgress?.activeSubagents ?? []).join() === (nextTask.executionProgress?.activeSubagents ?? []).join() &&
    prevTask.subtasks.length === nextTask.subtasks.length &&
    prevTask.metadata?.fastMode === nextTask.metadata?.fastMode &&
    prevTask.metadata?.priority === nextTask.metadata?.priority &&
    prevTask.metadata?.archivedAt === nextTask.metadata?.archivedAt &&
    prevTask.metadata?.prUrl === nextTask.metadata?.prUrl &&
    prevTask.metadata?.useWorktree === nextTask.metadata?.useWorktree &&
    (prevTask.metadata?.dependencies ?? []).join(',') === (nextTask.metadata?.dependencies ?? []).join(',') &&
    // Check if any subtask statuses changed (compare all subtasks)
    prevTask.subtasks.every((s, i) => s.status === nextTask.subtasks[i]?.status)
  );
}

/** Short form of a dependency for the card: the spec number ("012-invoice-api" → "012"). */
export function shortDependency(dep: string): string {
  return /^(\d+)(?:-|$)/.exec(dep)?.[1] ?? dep;
}

/** Priority as a severity chip: urgent/high filled signal, medium outlined, low quiet. */
function PriorityChip({ priority, label }: { priority: string; label: string }) {
  return (
    <span
      data-testid="priority-chip"
      className={cn(
        'inline-flex shrink-0 items-center px-[7px] py-[3px] text-[11px] font-semibold uppercase leading-none tracking-[0.06em]',
        'bg-destructive text-destructive-foreground'
      )}
    >
      {label}
    </span>
  );
}

type ChipTone = 'attention' | 'outline' | 'low';

/** Status chip per the design system: attention = signal fill, outline = ink frame, low = quiet fill. */
function Chip({ tone, title, children }: { tone: ChipTone; title?: string; children: React.ReactNode }) {
  return (
    <span
      data-testid="status-chip"
      title={title}
      className={cn(
        'inline-flex h-5 max-w-full min-w-0 items-center px-1.5 text-[11px] font-medium leading-none',
        tone === 'attention' && 'bg-destructive text-destructive-foreground',
        tone === 'outline' && 'border border-foreground text-foreground',
        tone === 'low' && 'bg-accent text-muted-foreground'
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** Helper subagents working right now: a pulsing mark and how many, names on hover. */
function SubagentsBadge({ names }: { names: string[] }) {
  const { t } = useTranslation('tasks');
  const list = names.map((n) => t(`board.subagents.names.${n}`, { defaultValue: n.replace(/_/g, ' ') })).join(', ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground"
          aria-label={t('board.subagents.working', { count: names.length, names: list })}
        >
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-foreground" />
          {t('board.subagents.count', { count: names.length })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        {t('board.subagents.working', { count: names.length, names: list })}
      </TooltipContent>
    </Tooltip>
  );
}

/** Words for the stage line: who is working and on what. */
function useStageLine(task: Task, stage: TaskStageInfo, isStuck: boolean, isIncomplete: boolean) {
  const { t } = useTranslation('tasks');
  const currentSubtaskId = task.executionProgress?.currentSubtask;
  const currentSubtask = currentSubtaskId
    ? task.subtasks.find((s) => s.id === currentSubtaskId)
    : task.subtasks.find((s) => s.status === 'in_progress');

  let role: string;
  let detail: string | undefined;
  if (task.status === 'pr_created') role = t('board.line.prCreated');
  else if (stage.finished) role = t('board.line.done');
  else if (task.status === 'queue') role = t('board.line.queued');
  else if (stage.current === 'review') role = t('board.line.yourReview');
  else if (stage.agent) {
    role = t(`board.agents.${stage.agent}`);
    if (stage.paused) detail = t(`board.line.paused.${stage.paused}`);
    else if (stage.agent === 'coder' && currentSubtask) detail = currentSubtask.title;
    else if (stage.agent === 'qaFixer') detail = t('board.line.fixingQa');
  } else if (stage.current && task.executionProgress?.phase === 'failed') {
    role = t(`board.stages.${stage.current}`);
    detail = t('board.line.failed');
  } else role = task.subtasks.length > 0 ? t('board.line.planReady') : t('board.line.notStarted');

  if (isStuck) detail = t('labels.stuck');
  if (isIncomplete) detail = t('labels.incomplete');
  return { role, detail };
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  onStatusChange,
  isSelectable,
  isSelected,
  onToggleSelect
}: TaskCardProps) {
  const { t, i18n } = useTranslation(['tasks', 'errors']);
  const pendingQuestion = useAgentQuestionsStore(selectTaskQuestion(task.id));
  const openQuestion = useAgentQuestionsStore((s) => s.open);
  const { toast } = useToast();
  const [isStuck, setIsStuck] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const stuckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const isRunning = task.status === 'in_progress';
  const isIncomplete = isIncompleteHumanReview(task);
  const isArchived = !!task.metadata?.archivedAt;

  const stage = useMemo(() => getTaskStage(task), [task]);
  const counts = useMemo(() => countSubtasks(task), [task]);
  const { role, detail } = useStageLine(task, stage, isStuck, isIncomplete);

  // Truncated description — shown only while nothing else describes the task yet
  const sanitizedDescription = useMemo(() => {
    if (!task.description) return null;
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      return sanitizeMarkdownForDisplay(t('errors:task.jsonError.description', { error: errorMessage }), 120);
    }
    return sanitizeMarkdownForDisplay(task.description, 120);
  }, [task.description, t]);

  const displayTitle = useMemo(() => {
    if (task.title.endsWith(JSON_ERROR_TITLE_SUFFIX)) {
      const baseName = task.title.slice(0, -JSON_ERROR_TITLE_SUFFIX.length);
      return `${baseName} ${t('errors:task.jsonError.titleSuffix')}`;
    }
    return task.title;
  }, [task.title, t]);

  const since = useMemo(() => formatSince(task.updatedAt, i18n.language), [task.updatedAt, i18n.language]);

  const statusMenuItems = useMemo(() => {
    if (!onStatusChange) return null;
    return TASK_STATUS_COLUMNS.filter(status => status !== task.status).map((status) => (
      <DropdownMenuItem key={status} onClick={() => onStatusChange(status)}>
        {t(TASK_STATUS_LABELS[status])}
      </DropdownMenuItem>
    ));
  }, [task.status, onStatusChange, t]);

  // Catastrophic stuck detection — last-resort safety net.
  useEffect(() => {
    if (!isRunning) {
      setIsStuck(false);
      if (stuckIntervalRef.current) {
        clearInterval(stuckIntervalRef.current);
        stuckIntervalRef.current = null;
      }
      return;
    }

    stuckIntervalRef.current = setInterval(() => {
      if (hasRecentActivity(task.id)) {
        setIsStuck(false);
        return;
      }
      checkTaskRunning(task.id).then((actuallyRunning) => {
        if (hasRecentActivity(task.id)) {
          setIsStuck(false);
        } else {
          setIsStuck(!actuallyRunning);
        }
      });
    }, STUCK_CHECK_INTERVAL_MS);

    return () => {
      if (stuckIntervalRef.current) {
        clearInterval(stuckIntervalRef.current);
      }
    };
  }, [task.id, isRunning]);

  const handleStartStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      // Stopping works for stuck tasks too
      stopTask(task.id);
    } else {
      const result = await startTaskOrQueue(task.id);
      if (!result.success) {
        toast({
          title: t('tasks:wizard.errors.startFailed'),
          description: result.error,
          variant: 'destructive',
        });
      } else if (result.action === 'queued') {
        toast({ title: t('tasks:queue.movedToQueue') });
      }
    }
  };

  const handleRecover = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRecovering(true);
    const result = await recoverStuckTask(task.id, { autoRestart: true });
    if (result.success) {
      setIsStuck(false);
    }
    setIsRecovering(false);
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await archiveTasks(task.projectId, [task.id]);
    if (!result.success) {
      console.error('[TaskCard] Failed to archive task:', task.id, result.error);
    }
  };

  const handleViewPR = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.metadata?.prUrl && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(task.metadata.prUrl);
    }
  };

  const preview = usePreview(task);
  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (preview?.state === 'ready') openWebUrl(preview.url);
    else if (preview?.state === 'built' && isHttpsUrl(preview.logUrl)) openWebUrl(preview.logUrl);
    else if (preview?.state === 'building' && isHttpsUrl(preview.previousUrl)) openWebUrl(preview.previousUrl);
    else if (preview?.state === 'failed' && preview.runId === undefined && isHttpsUrl(preview.logUrl)) {
      // Vercel built it (no Actions run): its build log says why
      openWebUrl(preview.logUrl);
    } else if (preview?.state === 'failed') {
      const detail: DeployTarget = { tab: 'runs' };
      if (preview.runId !== undefined) detail.runId = preview.runId;
      if (preview.jobId !== undefined) detail.jobId = preview.jobId;
      window.dispatchEvent(new CustomEvent<DeployTarget>('open-deploy', { detail }));
    }
  };

  const securityQaError = useSecurityQaError(task);
  const mergeState = useMergeState(task);
  const verification = useVerification(task);

  // Chip: why the task stands where it stands (word always shown, never colour alone)
  const chip: { tone: ChipTone; label: string } | null = (() => {
    if (isStuck) return { tone: 'attention', label: t('labels.needsRecovery') };
    if (isIncomplete) return { tone: 'attention', label: t('labels.needsResume') };
    if (stage.paused) return { tone: 'attention', label: t(`board.chip.paused.${stage.paused}`) };
    if (task.executionProgress?.phase === 'failed' && task.status === 'in_progress') return { tone: 'attention', label: t('board.chip.failed') };
    if (task.status === 'error') return { tone: 'attention', label: t('board.chip.failed') };
    if (task.status === 'human_review') {
      if (mergeState?.state === 'merging') return { tone: 'outline', label: t('board.chip.merging') };
      if (mergeState?.state === 'failed') return { tone: 'attention', label: t('board.chip.mergeFailed') };
      if (mergeState?.state === 'review') return { tone: 'attention', label: t('board.chip.mergeReview') };
      const reason = task.executionProgress?.phase === 'complete' ? 'completed' : task.reviewReason;
      if (reason === 'errors') return { tone: 'attention', label: t('reviewReason.hasErrors') };
      if (reason === 'qa_rejected') return { tone: 'attention', label: t('reviewReason.qaIssues') };
      if (reason === 'plan_review') return { tone: 'outline', label: t('reviewReason.approvePlan') };
      if (reason === 'design_review') return { tone: 'attention', label: t('reviewReason.approveDesign') };
      if (reason === 'stopped') return { tone: 'outline', label: t('reviewReason.stopped') };
      if (reason === 'completed' && securityQaError) return { tone: 'attention', label: t('board.chip.securityQaFailed') };
      if (reason === 'completed' && task.waitingForPreview) return { tone: 'attention', label: t('board.chip.waitingForPreview') };
      if (reason === 'completed' && (verification?.status === 'not_verified' || verification?.status === 'not_configured')) return { tone: 'outline', label: t('board.chip.checksIncomplete') };
      if (reason === 'completed') return { tone: 'outline', label: t('board.chip.qaPassed') };
    }
    if (isArchived) return { tone: 'low', label: t('status.archived') };
    return null;
  })();
  const needsAttention = !!pendingQuestion || chip?.tone === 'attention';

  // Brief import: tasks that wait on others say so until they start
  const dependencies = task.metadata?.dependencies ?? [];
  const showDependencies = dependencies.length > 0 && (task.status === 'backlog' || task.status === 'queue');
  const dependencyList = dependencies.map(shortDependency).join(', ');

  const priority = task.metadata?.priority;
  const showPriority = priority === 'urgent' || priority === 'high';
  const showDescription = !stage.current && !stage.finished && counts.total === 0 && !!sanitizedDescription;

  const showPreview =
    preview?.state === 'building' ||
    (preview?.state === 'ready' && isHttpsUrl(preview.url)) ||
    (preview?.state === 'built' && isHttpsUrl(preview.logUrl)) ||
    preview?.state === 'failed';

  const actionClass =
    'flex min-h-11 min-w-0 flex-1 items-center justify-start gap-2 px-4 text-sm font-medium ' +
    'focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-50';

  const label = (text: string) => <span className="min-w-0 truncate">{text}</span>;

  const renderAction = () => {
    if (isStuck) {
      const text = isRecovering ? t('labels.recovering') : t('actions.recover');
      return (
        <button type="button" aria-label={text} title={text} className={cn(actionClass, 'bg-primary text-primary-foreground hover:bg-primary/90')} onClick={handleRecover} disabled={isRecovering}>
          {isRecovering ? <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <RotateCcw aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          {label(text)}
        </button>
      );
    }
    if (isIncomplete) {
      return (
        <button type="button" aria-label={t('actions.resume')} title={t('actions.resume')} className={cn(actionClass, 'bg-primary text-primary-foreground hover:bg-primary/90')} onClick={handleStartStop}>
          <Play aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {label(t('actions.resume'))}
        </button>
      );
    }
    if (task.status === 'done' || task.status === 'pr_created') {
      return (
        <>
          {task.metadata?.prUrl && (
            <button
              type="button"
              className={cn(actionClass, 'w-11 flex-none justify-center border-r border-border px-0 text-foreground hover:bg-accent')}
              onClick={handleViewPR}
              aria-label={t('tooltips.viewPR')}
            >
              <GitPullRequest aria-hidden className="h-4 w-4" />
            </button>
          )}
          {!isArchived && (
            <button
              type="button"
              className={cn(actionClass, 'text-foreground hover:bg-accent')}
              onClick={handleArchive}
              title={t('actions.archive')}
            >
              <Archive aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {label(t('actions.archive'))}
            </button>
          )}
        </>
      );
    }
    if (task.status === 'backlog' || task.status === 'in_progress') {
      return isRunning ? (
        <button type="button" aria-label={t('actions.stop')} title={t('actions.stop')} className={cn(actionClass, 'text-foreground hover:bg-accent')} onClick={handleStartStop}>
          <Square aria-hidden className="h-3 w-3 shrink-0" />
          {label(t('actions.stop'))}
        </button>
      ) : (
        <button type="button" aria-label={t('actions.start')} title={t('actions.start')} className={cn(actionClass, 'bg-primary text-primary-foreground hover:bg-primary/90')} onClick={handleStartStop}>
          <Play aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {label(t('actions.start'))}
        </button>
      );
    }
    return null;
  };
  const action = renderAction();

  return (
    <div
      className={cn(
        'group relative cursor-pointer border bg-card text-card-foreground transition-colors duration-150',
        isRunning && !isStuck ? 'border-foreground' : 'border-border hover:border-muted-foreground',
        isArchived && 'opacity-60 hover:opacity-80',
        isSelectable && isSelected && 'outline-2 outline-solid outline-foreground -outline-offset-1'
      )}
      data-attention={needsAttention || undefined}
      onClick={onClick}
    >
      {/* Left mark: vermilion only when the task needs the user */}
      {needsAttention && <span aria-hidden className="absolute inset-y-[-1px] left-[-1px] w-[3px] bg-destructive" />}

      <div className="px-4 pt-3.5 pb-3">
        {/* Stage line */}
        <div className="flex min-h-5 items-center gap-2">
          {isSelectable && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('tasks:actions.selectTask', { title: displayTitle })}
              className="mr-0.5"
            />
          )}
          <StageTicks info={stage} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
            <span className={cn('shrink-0 font-semibold', stage.running ? 'text-foreground' : 'text-muted-foreground')}>{role}</span>
            {detail && <span className="truncate text-muted-foreground">{detail}</span>}
          </span>
          {stage.running && (task.executionProgress?.activeSubagents?.length ?? 0) > 0 && (
            <SubagentsBadge names={task.executionProgress?.activeSubagents ?? []} />
          )}
        </div>

        {/* Title */}
        <h3 title={displayTitle} className="mt-2 line-clamp-3 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
          {displayTitle}
        </h3>

        {showDescription && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{sanitizedDescription}</p>
        )}

        {/* Subtasks */}
        {counts.total > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <SubtaskBar subtasks={task.subtasks} className="flex-1" />
            <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
              <span aria-hidden="true">{counts.done}/{counts.total}</span>
              <span className="sr-only">{t('board.subtasksAria', { done: counts.done, total: counts.total })}</span>
              {counts.failed > 0 && <span className="ml-1.5 text-destructive">✕{counts.failed}</span>}
            </span>
          </div>
        )}

        {/* Meta row: priority, time, and what the task is running on or waiting for */}
        <div data-testid="task-meta-row" className="mt-3 flex flex-wrap items-center gap-2">
          {chip && <Chip tone={chip.tone} title={chip.label}>{chip.label}</Chip>}
          {showPriority && priority && <PriorityChip priority={priority} label={t(`overview.values.priority.${priority}`)} />}
          {priority && !showPriority && (
            <span data-testid="priority-plain" className="text-xs text-muted-foreground">{t(`overview.values.priority.${priority}`)}</span>
          )}
          {since && (
            <time className="font-mono text-xs tabular-nums text-muted-foreground" dateTime={new Date(task.updatedAt).toISOString()}>
              {since}
            </time>
          )}
          {task.location === 'worktree' && (
            <span className="font-mono text-xs text-foreground">{t('board.worktree')}</span>
          )}
          {showDependencies && (
            <span className="min-w-0 font-mono text-xs text-foreground">
              <span aria-hidden="true">{t('briefImport.card.after', { list: dependencyList })}</span>
              <span className="sr-only">{t('briefImport.card.afterAria', { list: dependencies.join(', ') })}</span>
            </span>
          )}
          {task.metadata?.fastMode && <span className="text-xs text-muted-foreground">{t('metadata.fastMode')}</span>}
        </div>
      </div>

      {/* An agent of this task is waiting for the user's answer */}
      {pendingQuestion && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openQuestion(pendingQuestion.questionId);
          }}
          aria-label={`${t('agentQuestions.waiting')} ${t('agentQuestions.openQuestion')}`}
          className="flex h-auto min-h-11 w-full items-center gap-2 border-t border-border bg-destructive px-3 py-1 text-left text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-destructive-foreground"
        >
          <span aria-hidden className="vt-breathe h-2 w-2 shrink-0 bg-destructive-foreground" />
          <span className="min-w-0 flex-1 line-clamp-2">{t('agentQuestions.waiting')}</span>
          <span className="shrink-0 font-semibold underline underline-offset-2">{t('agentQuestions.openQuestion')}</span>
        </button>
      )}

      {/* Preview row: its own full-width row, never squeezed into the strip */}
      {showPreview && preview && (
        <button
          type="button"
          data-testid="task-preview-row"
          className={cn(
            'flex min-h-11 w-full items-center gap-2.5 border-t border-border px-3 text-left text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2',
            preview.state === 'failed' ? 'text-destructive' : 'text-foreground'
          )}
          onClick={handlePreview}
          aria-busy={preview.state === 'building' || undefined}
          aria-disabled={preview.state === 'building' && !isHttpsUrl(preview.previousUrl) ? true : undefined}
          title={preview.state === 'ready' ? t('taskPreview.readyTitle', { url: preview.url, when: formatRelative(preview.builtAt, i18n.language) }) : undefined}
        >
          <span
            aria-hidden
            data-testid="task-preview-mark"
            data-marker={preview.state === 'building' ? 'running' : undefined}
            className={cn('h-2 w-2 shrink-0', preview.state === 'failed' ? 'bg-destructive' : 'bg-foreground', preview.state === 'building' && 'vt-breathe')}
          />
          <span className="min-w-0 flex-1 truncate">{t(`taskPreview.${preview.state === 'building' ? 'button' : preview.state === 'built' ? 'builtInVercel' : preview.state}`)}</span>
          {preview.state === 'building' && <span className="sr-only">{t('taskPreview.building')}</span>}
          {preview.state === 'ready' && formatSince(preview.builtAt, i18n.language) && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {t('taskPreview.built', { when: formatSince(preview.builtAt, i18n.language) })}
            </span>
          )}
        </button>
      )}

      {/* Action strip: buttons only */}
      {(action || statusMenuItems) && (
        <div data-testid="task-action-strip" className="flex items-stretch border-t border-foreground">
          {action}
          {statusMenuItems && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(actionClass, 'ml-auto w-11 flex-none justify-center px-0 text-muted-foreground hover:text-foreground', action && 'border-l border-border')}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t('actions.taskActions')}
                >
                  <MoreVertical aria-hidden className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuLabel>{t('actions.moveTo')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {statusMenuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}, taskCardPropsAreEqual);
