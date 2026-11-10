/**
 * Task Overview: what the agent team is doing with this task, in one screen.
 *
 *   [ agent is asking … ]                        (only while a question waits)
 *   PIPELINE  spec │ architect │ planner │ coder │ QA │ review
 *   [ review section ]                           (human review only)
 *   ┌───────────────────────────────┬──────────────┐
 *   │ Subtasks 4/6 + rows           │ Facts        │
 *   │ Checks (ACs, architecture,    │ (datasheet)  │
 *   │   security) → workspace       │              │
 *   │ Description + context         │              │
 *   └───────────────────────────────┴──────────────┘
 */

import { type ReactNode, useMemo } from 'react';
import type { Task } from '../../../../shared/types';
import { selectTaskQuestion, useAgentQuestionsStore } from '../../../stores/agent-questions-store';
import { getTaskStage } from '../../board/task-stage';
import { TaskMetadata } from '../TaskMetadata';
import { OverviewSubtasks } from './OverviewSubtasks';
import { PendingQuestion, stageOfAgent } from './PendingQuestion';
import { PipelineStrip, type StageTarget } from './PipelineStrip';
import { TaskFacts } from './TaskFacts';
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot';
import { WorkspaceChecks } from './WorkspaceChecks';

export type WorkspaceSection = 'spec' | 'plan' | 'architecture' | 'security';

export function OverviewTab({
  task,
  reviewSlot,
  onOpenWorkspace,
  onOpenSubtasks,
  onOpenDesign,
}: {
  task: Task;
  /** Human review block (merge / feedback), rendered right under the pipeline */
  reviewSlot?: ReactNode;
  onOpenWorkspace: (section: WorkspaceSection) => void;
  onOpenSubtasks: () => void;
  /** The Design tab (design before code) */
  onOpenDesign?: () => void;
}) {
  const pendingQuestion = useAgentQuestionsStore(selectTaskQuestion(task.id));
  const openQuestion = useAgentQuestionsStore((s) => s.open);
  const stage = useMemo(() => getTaskStage(task), [task]);
  const { workspace, loading } = useWorkspaceSnapshot(task);

  const openTarget = (target: Exclude<StageTarget, null>) => {
    if (target === 'subtasks') onOpenSubtasks();
    else if (target === 'design') onOpenDesign?.();
    else onOpenWorkspace(target);
  };

  return (
    <div className="space-y-8 px-6 py-6">
      {pendingQuestion && <PendingQuestion question={pendingQuestion} onAnswer={() => openQuestion(pendingQuestion.questionId)} />}

      <PipelineStrip
        info={stage}
        message={task.executionProgress?.message}
        waitingStage={pendingQuestion ? (stageOfAgent(pendingQuestion.agentType) ?? stage.current) : null}
        onOpen={openTarget}
      />

      {reviewSlot}

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-8">
          <OverviewSubtasks task={task} onOpenAll={onOpenSubtasks} onOpenPlan={() => onOpenWorkspace('plan')} />
          <WorkspaceChecks workspace={workspace} loading={loading} onOpen={onOpenWorkspace} />
          <TaskMetadata task={task} />
        </div>
        <aside className="min-w-0">
          <TaskFacts task={task} />
        </aside>
      </div>
    </div>
  );
}
