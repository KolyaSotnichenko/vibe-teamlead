import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useToast } from '../../hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipProvider } from '../ui/tooltip';
import { Button } from '../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  Play,
  Square,
  CheckCircle2,
  RotateCcw,
  Trash2,
  Loader2,
  AlertTriangle,
  Pencil,
  X,
  GitPullRequest
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { stopTask, submitReview, recoverStuckTask, deleteTask, useTaskStore, startTaskOrQueue } from '../../stores/task-store';
import { useProjectStore } from '../../stores/project-store';
import { TASK_STATUS_LABELS } from '../../../shared/constants';
import { TaskEditDialog } from '../TaskEditDialog';
import { useTaskDetail } from './hooks/useTaskDetail';
import { TaskWarnings, gaveUpSubtasks } from './TaskWarnings';
import { MergeStateNotice } from './MergeStateNotice';
import { SecurityQaNotice } from './SecurityQaNotice';
import { VerificationNotice } from './VerificationNotice';
import { SecurityFollowupNotice } from './SecurityFollowupNotice';
import { useMergeState } from './useMergeState';
import { TurnLimitNotice } from './TurnLimitNotice';
import { TaskSubtasks } from './TaskSubtasks';
import { TaskLogs } from './TaskLogs';
import { TaskFiles } from './TaskFiles';
import { TaskReview } from './TaskReview';
import { TaskWorkspacePanel } from './workspace/TaskWorkspacePanel';
import { MonoTag } from './workspace/workspace-ui';
import { OverviewTab, type WorkspaceSection } from './overview/OverviewTab';
import type { FailedSubtaskDecision, Task, WorktreeCreatePROptions } from '../../../shared/types';

interface TaskDetailModalProps {
  open: boolean;
  task: Task | null;
  onOpenChange: (open: boolean) => void;
  onSwitchToTerminals?: () => void;
  onOpenInbuiltTerminal?: (id: string, cwd: string) => void;
}

export function TaskDetailModal({ open, task, onOpenChange, onSwitchToTerminals, onOpenInbuiltTerminal }: TaskDetailModalProps) {
  // Don't render anything if no task
  if (!task) {
    return null;
  }

  return (
    <TaskDetailModalContent
      open={open}
      task={task}
      onOpenChange={onOpenChange}
      onSwitchToTerminals={onSwitchToTerminals}
      onOpenInbuiltTerminal={onOpenInbuiltTerminal}
    />
  );
}

// Feature flag for Files tab (enabled by default, can be disabled via localStorage)
const isFilesTabEnabled = () => {
  const flag = localStorage.getItem('use_files_tab');
  return flag === null || flag === 'true'; // Enabled by default
};

// Separate component to use hooks only when task exists
function TaskDetailModalContent({ open, task, onOpenChange, onSwitchToTerminals, onOpenInbuiltTerminal }: { open: boolean; task: Task; onOpenChange: (open: boolean) => void; onSwitchToTerminals?: () => void; onOpenInbuiltTerminal?: (id: string, cwd: string) => void }) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();
  const state = useTaskDetail({ task });
  const [mergeReviewKey, setMergeReviewKey] = useState(0);
  const mergeState = useMergeState(task);
  const activeProject = useProjectStore(s => s.getActiveProject());
  const showFilesTab = isFilesTabEnabled();
  const completedSubtasks = task.subtasks.filter(s => s.status === 'completed').length;
  const totalSubtasks = task.subtasks.length;

  // Event Handlers
  const handleStartStop = async () => {
    // Stop also when the task looks stuck (its process is gone but it still says running)
    if (state.isRunning) {
      stopTask(task.id);
    } else {
      // If task is incomplete, validate and reload plan before starting
      if (state.isIncomplete) {
        const isValid = await state.reloadPlanForIncompleteTask();
        if (!isValid) {
          toast({
            title: t('tasks:taskDetail.cannotResumeTitle'),
            description: t('tasks:taskDetail.cannotResumeBody'),
            variant: 'destructive',
            duration: 5000,
          });
          return;
        }
      }
      await startNow();
    }
  };

  const startNow = async () => {
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
  };

  // Subtasks the coder gave up on and said why: resuming as is would stop at them again
  const gaveUp = state.isIncomplete ? gaveUpSubtasks(task.subtasks) : [];
  const [isDeciding, setIsDeciding] = useState(false);
  const handleFailedSubtasks = async (decision: FailedSubtaskDecision) => {
    setIsDeciding(true);
    try {
      const saved = await window.electronAPI.resolveFailedSubtasks(task.id, decision);
      if (!saved.success) {
        toast({ title: t('tasks:taskDetail.warnings.decisionFailed'), description: saved.error, variant: 'destructive' });
        return;
      }
      await startNow();
    } finally {
      setIsDeciding(false);
    }
  };

  const handleRecover = async () => {
    state.setIsRecovering(true);
    const result = await recoverStuckTask(task.id, { autoRestart: true });
    if (result.success) {
      state.setIsStuck(false);
      state.setHasCheckedRunning(false);
    }
    state.setIsRecovering(false);
  };

  const handleReject = async () => {
    // Allow submission if there's text feedback OR images attached
    if (!state.feedback.trim() && state.feedbackImages.length === 0) {
      return;
    }
    state.setIsSubmitting(true);
    const started = await submitReview(task.id, false, state.feedback, state.feedbackImages);
    state.setIsSubmitting(false);
    if (!started) {
      // Keep what the user wrote: nothing was sent
      toast({ title: t('tasks:qaOutcome.startFailed'), variant: 'destructive' });
      return;
    }
    state.setFeedback('');
    state.setFeedbackImages([]);
  };

  const handleDelete = async () => {
    state.setIsDeleting(true);
    state.setDeleteError(null);
    const result = await deleteTask(task.id);
    if (result.success) {
      state.setShowDeleteDialog(false);
      onOpenChange(false);
    } else {
      state.setDeleteError(result.error || t('tasks:taskDetail.deleteFailed'));
    }
    state.setIsDeleting(false);
  };

  const handleMerge = async () => {
    state.setIsMerging(true);
    state.setWorkspaceError(null);
    try {
      const result = await window.electronAPI.mergeWorktree(task.id, { noCommit: state.stageOnly });
      if (result.success && result.data?.success) {
        if (state.stageOnly && result.data.staged) {
          state.setWorkspaceError(null);
          state.setStagedSuccess(result.data.message || t('tasks:taskDetail.changesStaged'));
          state.setStagedProjectPath(result.data.projectPath);
          state.setSuggestedCommitMessage(result.data.suggestedCommitMessage);
        } else if (result.data.needsReview) {
          // The commit waits for the user: stay here, with the files to check
          setMergeReviewKey((key) => key + 1);
        } else {
          onOpenChange(false);
        }
      } else {
        state.setWorkspaceError(result.data?.message || result.error || t('tasks:taskDetail.mergeFailed'));
      }
    } catch (error) {
      state.setWorkspaceError(error instanceof Error ? error.message : t('tasks:taskDetail.mergeUnknownError'));
    } finally {
      state.setIsMerging(false);
    }
  };

  const handleDiscard = async () => {
    state.setIsDiscarding(true);
    state.setWorkspaceError(null);
    const result = await window.electronAPI.discardWorktree(task.id);
    if (result.success && result.data?.success) {
      state.setShowDiscardDialog(false);
      onOpenChange(false);
    } else {
      state.setWorkspaceError(result.data?.message || result.error || t('tasks:taskDetail.discardFailed'));
    }
    state.setIsDiscarding(false);
  };

  const handleCreatePR = async (options: WorktreeCreatePROptions) => {
    state.setIsCreatingPR(true);
    try {
      const result = await window.electronAPI.createWorktreePR(task.id, options);
      if (result.success && result.data) {
        // Update single task in store with new status and prUrl (more efficient than reloading all tasks)
        if (result.data.success && result.data.prUrl && !result.data.alreadyExists) {
          useTaskStore.getState().updateTask(task.id, {
            status: 'done',
            metadata: { ...task.metadata, prUrl: result.data.prUrl }
          });
        }
        return result.data;
      }
      // Propagate IPC error; let CreatePRDialog use its i18n fallback
      return { success: false, error: result.error, prUrl: undefined, alreadyExists: false };
    } catch (error) {
      // Propagate actual error message; let CreatePRDialog handle i18n fallback for undefined
      return { success: false, error: error instanceof Error ? error.message : undefined, prUrl: undefined, alreadyExists: false };
    } finally {
      state.setIsCreatingPR(false);
    }
  };

  const handleClose = () => {
    // Show toast notification if task is running
    if (state.isRunning && !state.isStuck) {
      toast({
        title: t('tasks:notifications.backgroundTaskTitle'),
        description: t('tasks:notifications.backgroundTaskDescription'),
        duration: 4000,
      });
    }
    onOpenChange(false);
  };

  /** Open a Workspace section: switch tabs, then focus its section tab (Radix activates on focus). */
  const openWorkspaceSection = (section: WorkspaceSection) => {
    state.setActiveTab('workspace');
    const order: WorkspaceSection[] = ['spec', 'plan', 'architecture', 'security'];
    let attempts = 0;
    const focusSection = () => {
      const list = document.querySelector<HTMLElement>(`[role="tablist"][aria-label="${t('tasks:workspace.sections.label')}"]`);
      const trigger = list?.querySelectorAll<HTMLElement>('[role="tab"]')[order.indexOf(section)];
      if (trigger) trigger.focus();
      else if (attempts++ < 10) requestAnimationFrame(focusSection);
    };
    requestAnimationFrame(focusSection);
  };

  const reviewReasonChip = (() => {
    if (task.status !== 'human_review' || !task.reviewReason) return null;
    switch (task.reviewReason) {
      case 'completed':
        return { label: t('tasks:board.chip.qaPassed'), attention: false };
      case 'errors':
        return { label: t('tasks:reviewReason.hasErrors'), attention: true };
      case 'qa_rejected':
        return { label: t('tasks:reviewReason.qaIssues'), attention: true };
      case 'plan_review':
        return { label: t('tasks:reviewReason.approvePlan'), attention: false };
      case 'stopped':
        return { label: t('tasks:reviewReason.stopped'), attention: false };
      default:
        return null;
    }
  })();

  const chipClass = (attention: boolean) =>
    cn(
      'inline-flex h-6 items-center px-2 text-xs font-medium',
      attention ? 'bg-destructive text-destructive-foreground' : 'border border-foreground text-foreground'
    );

  const tabTriggerClass =
    'relative h-11 rounded-none border-b-2 border-transparent px-4 text-sm text-muted-foreground shadow-none ' +
    'data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none';

  // Render primary action button based on state
  const renderPrimaryAction = () => {
    if (state.isStuck) {
      return (
        <Button
          className="h-11"
          onClick={handleRecover}
          disabled={state.isRecovering}
        >
          {state.isRecovering ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('tasks:labels.recovering')}
            </>
          ) : (
            <>
              <RotateCcw className="mr-2 h-4 w-4" />
              {t('tasks:taskDetail.recover')}
            </>
          )}
        </Button>
      );
    }

    // The banner offers what can help instead: a plain Resume would stop at the same subtask
    if (state.isIncomplete && gaveUp.length > 0) return null;

    if (state.isIncomplete) {
      return (
        <Button variant="default" className="h-11" onClick={handleStartStop} disabled={state.isLoadingPlan}>
          {state.isLoadingPlan ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('tasks:taskDetail.loadingPlan')}
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              {t('tasks:taskDetail.resume')}
            </>
          )}
        </Button>
      );
    }

    if (task.status === 'backlog' || task.status === 'in_progress') {
      return (
        <Button
          variant={state.isRunning ? 'outline' : 'default'}
          className={cn('h-11', state.isRunning && 'border-foreground')}
          onClick={handleStartStop}
        >
          {state.isRunning ? (
            <>
              <Square className="mr-2 h-4 w-4" />
              {t('tasks:taskDetail.stop')}
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              {t('tasks:taskDetail.start')}
            </>
          )}
        </Button>
      );
    }

    if (task.status === 'done' && task.metadata?.prUrl) {
      return (
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <CheckCircle2 aria-hidden className="h-4 w-4" />
            <span className="font-medium">{t('tasks:status.complete')}</span>
          </div>
           {task.metadata?.prUrl && (
             <button
               type="button"
               onClick={() => {
                 if (task.metadata?.prUrl) {
                   window.electronAPI?.openExternal(task.metadata.prUrl);
                 }
               }}
               className="inline-flex h-11 items-center gap-2 border border-foreground px-4 text-sm text-foreground hover:bg-accent"
             >
              <GitPullRequest aria-hidden className="h-4 w-4" />
              <span className="font-medium">{t(TASK_STATUS_LABELS[task.status])}</span>
            </button>
          )}
        </div>
      );
    }

    if (task.status === 'done') {
      return (
        <div className="flex items-center gap-2 text-sm text-foreground">
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          <span className="font-medium">{t('tasks:status.complete')}</span>
        </div>
      );
    }

    return null;
  };


  return (
    <TooltipProvider delayDuration={300}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          {/* Semi-transparent overlay - can see background content */}
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 z-50 bg-[rgb(28_29_25/0.6)]',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
            )}
          />

          {/* Full-height centered modal content */}
          <DialogPrimitive.Content
            className={cn(
              'fixed left-[50%] top-4 z-50',
              'translate-x-[-50%]',
              'w-[95vw] h-[calc(100vh-32px)]',
              'max-w-6xl', // one width for every tab, so the close buttons don't jump
              'bg-card border border-foreground',
              'overflow-hidden flex flex-col',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              'duration-200'
            )}
          >
            {/* Header */}
            <div className="shrink-0 border-b border-border px-6 pt-5 pb-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <DialogPrimitive.Title className="truncate text-[22px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
                    {task.title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description asChild>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <MonoTag>{task.specId}</MonoTag>
                      {state.isStuck ? (
                        <span className={chipClass(true)}>
                          <AlertTriangle aria-hidden className="mr-1 h-3 w-3" />
                          {t('tasks:labels.stuck')}
                        </span>
                      ) : state.isIncomplete ? (
                        <span className={chipClass(true)}>
                          <AlertTriangle aria-hidden className="mr-1 h-3 w-3" />
                          {t('tasks:labels.incomplete')}
                        </span>
                      ) : (
                        <>
                          <span className={chipClass(false)}>
                            {task.status === 'in_progress' && <span aria-hidden className="vt-breathe mr-1.5 h-2 w-2 bg-foreground" />}
                            {t(TASK_STATUS_LABELS[task.status])}
                          </span>
                          {reviewReasonChip && <span className={chipClass(reviewReasonChip.attention)}>{reviewReasonChip.label}</span>}
                        </>
                      )}
                      {totalSubtasks > 0 && (
                        <span className="ml-1 font-mono text-xs tabular-nums text-muted-foreground">
                          {t('tasks:taskDetail.subtaskCount', { done: completedSubtasks, total: totalSubtasks })}
                        </span>
                      )}
                    </div>
                  </DialogPrimitive.Description>
                  {window.DEBUG && (
                    <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                      status={task.status} reviewReason={task.reviewReason ?? 'none'} phase={task.executionProgress?.phase ?? 'none'} reviewRequired={task.metadata?.requireReviewBeforeCoding ? 'true' : 'false'}
                      <br />
                      projectId={activeProject?.id ?? 'none'} projectName={activeProject?.name ?? 'none'}
                    </div>
                  )}
                </div>
                <div className="electron-no-drag -mt-1 -mr-2 flex shrink-0 items-center">
                  <button
                    type="button"
                    className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                    onClick={() => state.setIsEditDialogOpen(true)}
                    disabled={state.isRunning && !state.isStuck}
                    aria-label={state.isRunning && !state.isStuck ? t('tasks:kanban.cannotEditWhileRunning') : t('tasks:kanban.editTask')}
                  >
                    <Pencil aria-hidden className="h-4 w-4" />
                  </button>
                  <DialogPrimitive.Close asChild>
                    <button
                      type="button"
                      className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={t('tasks:kanban.closeTaskDetailsAriaLabel')}
                    >
                      <X aria-hidden className="h-5 w-5" />
                    </button>
                  </DialogPrimitive.Close>
                </div>
              </div>

              {/* Warnings - compact inline */}
              <div className="mt-3 space-y-3 empty:hidden">
                {!state.workspaceError && <MergeStateNotice task={task} />}
                <VerificationNotice task={task} />
                <SecurityFollowupNotice task={task} />
                <SecurityQaNotice task={task} />
                <TurnLimitNotice task={task} />
              </div>
              {(state.isStuck || state.isIncomplete) && (
                <div className="mt-3">
                  <TaskWarnings
                    isStuck={state.isStuck}
                    isIncomplete={state.isIncomplete}
                    isRecovering={state.isRecovering}
                    taskProgress={state.taskProgress}
                    onRecover={handleRecover}
                    onResume={handleStartStop}
                    gaveUp={gaveUp}
                    isDeciding={isDeciding}
                    onSkipFailed={() => void handleFailedSubtasks({ action: 'skip', ids: gaveUp.map((s) => s.id) })}
                    onRetryFailed={(instruction) => void handleFailedSubtasks({ action: 'retry', instruction, ids: gaveUp.map((s) => s.id) })}
                  />
                </div>
              )}
            </div>

            {/* Body - Single Column with Tabs */}
            {/* relative: absolutely positioned bits deep in a tab (sr-only labels) must stay
                inside this clip, or they stretch the dialog and anything can scroll it */}
            <div className="relative flex-1 min-h-0 overflow-hidden">
              <Tabs value={state.activeTab} onValueChange={state.setActiveTab} className="flex flex-col h-full">
                <TabsList className="h-auto w-full shrink-0 justify-start rounded-none border-b border-border bg-transparent p-0 px-4">
                  <TabsTrigger
                    value="overview"
                    className={tabTriggerClass}
                  >
                    {t('tasks:taskDetail.tabs.overview')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="workspace"
                    className={tabTriggerClass}
                  >
                    {t('tasks:workspace.tab')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="subtasks"
                    className={tabTriggerClass}
                  >
                    {t('tasks:taskDetail.tabs.subtasks')}
                    <span className="ml-2 font-mono text-[11px] opacity-70">{task.subtasks.length}</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="logs"
                    className={tabTriggerClass}
                  >
                    {t('tasks:taskDetail.tabs.logs')}
                  </TabsTrigger>
                  {showFilesTab && (
                    <TabsTrigger
                      value="files"
                      className={tabTriggerClass}
                    >
                      {t('tasks:files.tab')}
                    </TabsTrigger>
                  )}
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
                    <div className="mx-auto max-w-[1100px] overflow-x-hidden">
                      <OverviewTab
                        task={task}
                        onOpenWorkspace={openWorkspaceSection}
                        onOpenSubtasks={() => state.setActiveTab('subtasks')}
                        reviewSlot={
                          state.needsReview ? (
                      <TaskReview
                        task={task}
                        feedback={state.feedback}
                        isSubmitting={state.isSubmitting}
                        worktreeStatus={state.worktreeStatus}
                        worktreeDiff={state.worktreeDiff}
                        isLoadingWorktree={state.isLoadingWorktree}
                        isMerging={state.isMerging || mergeState?.state === 'merging'}
                        isDiscarding={state.isDiscarding}
                        showDiscardDialog={state.showDiscardDialog}
                        showDiffDialog={state.showDiffDialog}
                        workspaceError={state.workspaceError}
                        stageOnly={state.stageOnly}
                        stagedSuccess={state.stagedSuccess}
                        stagedProjectPath={state.stagedProjectPath}
                        suggestedCommitMessage={state.suggestedCommitMessage}
                        mergeReviewKey={mergeReviewKey}
                        mergePreview={state.mergePreview}
                        isLoadingPreview={state.isLoadingPreview}
                        showConflictDialog={state.showConflictDialog}
                        onFeedbackChange={state.setFeedback}
                        onReject={handleReject}
                        images={state.feedbackImages}
                        onImagesChange={state.setFeedbackImages}
                        onMerge={handleMerge}
                        onDiscard={handleDiscard}
                        onShowDiscardDialog={state.setShowDiscardDialog}
                        onShowDiffDialog={state.setShowDiffDialog}
                        onStageOnlyChange={state.setStageOnly}
                        onShowConflictDialog={state.setShowConflictDialog}
                        onLoadMergePreview={state.loadMergePreview}
                        onClose={handleClose}
                        onSwitchToTerminals={onSwitchToTerminals}
                        onOpenInbuiltTerminal={onOpenInbuiltTerminal}
                        onReviewAgain={state.handleReviewAgain}
                        showPRDialog={state.showPRDialog}
                        isCreatingPR={state.isCreatingPR}
                        onShowPRDialog={state.setShowPRDialog}
                        onCreatePR={handleCreatePR}
                      />
                          ) : undefined
                        }
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* Workspace Tab: spec + ACs, plan graph + timeline, architecture */}
                <TabsContent value="workspace" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <TaskWorkspacePanel task={task} />
                </TabsContent>

                {/* Subtasks Tab */}
                <TabsContent value="subtasks" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <TaskSubtasks task={task} />
                </TabsContent>

                {/* Logs Tab */}
                <TabsContent value="logs" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <TaskLogs
                    task={task}
                    phaseLogs={state.phaseLogs}
                    isLoadingLogs={state.isLoadingLogs}
                    expandedPhases={state.expandedPhases}
                    isStuck={state.isStuck}
                    logsEndRef={state.logsEndRef}
                    logsContainerRef={state.logsContainerRef}
                    onLogsScroll={state.handleLogsScroll}
                    onTogglePhase={state.togglePhase}
                  />
                </TabsContent>

                {/* Files Tab */}
                {showFilesTab && (
                  <TabsContent value="files" className="flex-1 min-h-0 overflow-hidden mt-0">
                    <TaskFiles task={task} />
                  </TabsContent>
                )}
              </Tabs>
            </div>

            {/* Footer - Actions */}
            <div className="flex shrink-0 items-center gap-3 border-t border-border px-6 py-3">
              <button
                type="button"
                className="-ml-3 inline-flex h-11 items-center gap-2 px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                onClick={() => state.setShowDeleteDialog(true)}
                disabled={state.isRunning && !state.isStuck}
              >
                <Trash2 aria-hidden className="h-4 w-4" />
                {t('tasks:taskDetail.delete')}
              </button>
              <div className="flex-1" />
              {renderPrimaryAction()}
              <Button variant="outline" className="h-11 border-foreground" onClick={handleClose}>
                {t('tasks:taskDetail.close')}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Edit Task Dialog */}
      <TaskEditDialog
        task={task}
        open={state.isEditDialogOpen}
        onOpenChange={state.setIsEditDialogOpen}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={state.showDeleteDialog} onOpenChange={state.setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('tasks:deleteDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-3">
                <p>
                  {t('tasks:deleteDialog.confirmMessage')} <strong className="text-foreground">"{task.title}"</strong>?
                </p>
                {state.isCheckingChanges && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('tasks:deleteDialog.checkingChanges')}
                  </div>
                )}
                {state.worktreeChangesInfo?.hasChanges && (
                  <div className="bg-amber-500/10 border border-amber-500/30 px-3 py-2 rounded-lg text-sm space-y-1">
                    <p className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" />
                      {t('tasks:deleteDialog.uncommittedChanges', { count: state.worktreeChangesInfo.changedFileCount })}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('tasks:deleteDialog.uncommittedChangesHint')}
                    </p>
                  </div>
                )}
                <p className="text-destructive">
                  {t('tasks:deleteDialog.destructiveWarning')}
                </p>
                {state.deleteError && (
                  <p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">
                    {state.deleteError}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={state.isDeleting}>{t('tasks:deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={state.isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {state.isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('tasks:deleteDialog.deleting')}
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('tasks:deleteDialog.deletePermanently')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
