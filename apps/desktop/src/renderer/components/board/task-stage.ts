/**
 * Where a task is in the agent pipeline, derived only from data on the Task:
 * status, reviewReason, executionProgress (phase, message, completedPhases) and subtasks.
 *
 * Pipeline: spec → architect → planner → coder → QA → human review.
 * The orchestrator reports spec, architecture and planning all as the `planning`
 * phase; the sub-stage is told apart by the progress message it sends
 * ("Spec creation: …", "Designing the architecture", "Creating implementation plan").
 * Security gates run inside QA and Strix runs after QA approval without a phase
 * of their own, so they are part of the QA stage here.
 */

import type { ExecutionPhase, Task } from '../../../shared/types';

export const PIPELINE_STAGES = ['spec', 'architect', 'planner', 'coder', 'qa', 'review'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** done = passed, current = the stage the task is at now, failed = the stage that sent it back */
export type StageState = 'done' | 'current' | 'failed' | 'upcoming';

/** The agent role at work (QA fixing is a coder-type agent inside the QA stage) */
export type StageAgent = 'spec' | 'architect' | 'planner' | 'coder' | 'qa' | 'qaFixer' | 'you';

export interface TaskStageInfo {
  /** Stage the task is at; null before anything ran, or once the task is done */
  current: PipelineStage | null;
  /** An agent process is working on the current stage right now */
  running: boolean;
  /** Paused by a rate limit or an auth failure (needs attention) */
  paused: 'rate_limit' | 'auth' | null;
  /** Who acts at the current stage */
  agent: StageAgent | null;
  states: Record<PipelineStage, StageState>;
  /** All stages passed (done / PR created) */
  finished: boolean;
}

const ACTIVE_PHASES: ReadonlySet<ExecutionPhase> = new Set([
  'planning',
  'coding',
  'rate_limit_paused',
  'auth_failure_paused',
  'qa_review',
  'qa_fixing',
]);

/** Which planning sub-stage a progress message belongs to. Exported for tests. */
export function planningSubStage(message: string | undefined, hasSubtasks: boolean): 'spec' | 'architect' | 'planner' {
  const text = message ?? '';
  if (/^spec creation/i.test(text)) return 'spec';
  if (/architect/i.test(text)) return 'architect';
  if (/implementation plan|\(planning\)/i.test(text)) return 'planner';
  // No telling message: a task without a plan yet is still being specified.
  return hasSubtasks ? 'planner' : 'spec';
}

function statesFor(current: PipelineStage | null, failed?: PipelineStage): Record<PipelineStage, StageState> {
  const index = current ? PIPELINE_STAGES.indexOf(current) : -1;
  const states = {} as Record<PipelineStage, StageState>;
  PIPELINE_STAGES.forEach((stage, i) => {
    states[stage] = i < index ? 'done' : i === index ? 'current' : 'upcoming';
  });
  if (failed) {
    // Stages after the one that failed were never reached
    const failedIndex = PIPELINE_STAGES.indexOf(failed);
    PIPELINE_STAGES.forEach((stage, i) => {
      if (i > failedIndex && i < index) states[stage] = 'upcoming';
    });
    states[failed] = 'failed';
  }
  return states;
}

/** The furthest stage the recorded phases prove was reached */
function stageFromCompleted(task: Task): PipelineStage | null {
  const completed = task.executionProgress?.completedPhases ?? [];
  if (completed.includes('qa_review') || completed.includes('qa_fixing')) return 'qa';
  if (completed.includes('coding')) return 'coder';
  if (completed.includes('planning') || task.subtasks.length > 0) return 'planner';
  return null;
}

/**
 * Which stage an error came from. A failed QA run never records qa_review as
 * completed, so "coding finished" (or every subtask done) means it was QA,
 * not the code, that ended without approval.
 */
function failedStage(task: Task): PipelineStage {
  if (stageFromCompleted(task) === 'qa') return 'qa';
  const codingDone = (task.executionProgress?.completedPhases ?? []).includes('coding');
  const allSubtasksDone = task.subtasks.length > 0 && task.subtasks.every((s) => s.status === 'completed');
  return codingDone || allSubtasksDone ? 'qa' : 'coder';
}

export function getTaskStage(task: Task): TaskStageInfo {
  const progress = task.executionProgress;
  const phase = progress?.phase;
  const base = { running: false, paused: null, agent: null, finished: false } as const;

  if (task.status === 'done' || task.status === 'pr_created') {
    const states = {} as Record<PipelineStage, StageState>;
    for (const stage of PIPELINE_STAGES) states[stage] = 'done';
    return { ...base, current: null, states, finished: true };
  }

  if (task.status === 'human_review' || task.status === 'error') {
    let failed: PipelineStage | undefined;
    if (task.reviewReason === 'qa_rejected') failed = 'qa';
    else if (task.reviewReason === 'errors' || task.status === 'error') failed = failedStage(task);
    if (task.reviewReason === 'plan_review') {
      // Plan is written and waits for approval before any code
      const states = statesFor('review');
      states.coder = 'upcoming';
      states.qa = 'upcoming';
      return { ...base, current: 'review', agent: 'you', states };
    }
    const states = statesFor('review', failed);
    if (task.reviewReason === 'stopped') {
      // Stopped by the user: only stages the recorded phases prove are passed
      const reached = stageFromCompleted(task);
      const reachedIndex = reached ? PIPELINE_STAGES.indexOf(reached) : -1;
      PIPELINE_STAGES.forEach((stage, i) => {
        if (stage !== 'review' && i > reachedIndex) states[stage] = 'upcoming';
      });
    }
    return { ...base, current: 'review', agent: 'you', states };
  }

  if (task.status === 'ai_review') {
    const fixing = phase === 'qa_fixing';
    return { ...base, current: 'qa', running: true, agent: fixing ? 'qaFixer' : 'qa', states: statesFor('qa') };
  }

  if (task.status === 'in_progress' && phase && ACTIVE_PHASES.has(phase)) {
    if (phase === 'planning') {
      const sub = planningSubStage(progress?.message, task.subtasks.length > 0);
      return { ...base, current: sub, running: true, agent: sub, states: statesFor(sub) };
    }
    if (phase === 'qa_review' || phase === 'qa_fixing') {
      return {
        ...base,
        current: 'qa',
        running: true,
        agent: phase === 'qa_fixing' ? 'qaFixer' : 'qa',
        states: statesFor('qa'),
      };
    }
    const paused = phase === 'rate_limit_paused' ? 'rate_limit' : phase === 'auth_failure_paused' ? 'auth' : null;
    return { ...base, current: 'coder', running: paused === null, paused, agent: 'coder', states: statesFor('coder') };
  }

  if (task.status === 'in_progress' && phase === 'failed') {
    const reached = stageFromCompleted(task);
    const failedAt: PipelineStage = reached === 'coder' ? 'qa' : reached === 'planner' ? 'coder' : 'spec';
    return { ...base, current: failedAt, agent: null, states: statesFor(failedAt, failedAt) };
  }

  if (task.status === 'in_progress') {
    // Started, no phase reported yet: the spec writer is first
    return { ...base, current: 'spec', running: true, agent: 'spec', states: statesFor('spec') };
  }

  // backlog / queue: nothing running; a written plan proves spec and planning passed
  const reached = stageFromCompleted(task);
  if (reached) {
    const states = statesFor(reached);
    states[reached] = 'done';
    return { ...base, current: null, states };
  }
  return { ...base, current: null, states: statesFor(null) };
}

export interface SubtaskCounts {
  done: number;
  total: number;
  failed: number;
  inProgress: number;
}

export function countSubtasks(task: Task): SubtaskCounts {
  let done = 0;
  let failed = 0;
  let inProgress = 0;
  for (const s of task.subtasks) {
    if (s.status === 'completed') done += 1;
    else if (s.status === 'failed') failed += 1;
    else if (s.status === 'in_progress') inProgress += 1;
  }
  return { done, total: task.subtasks.length, failed, inProgress };
}

/**
 * Localised "time since", from a real timestamp (Intl.RelativeTimeFormat).
 * Returns null for an invalid date.
 */
export function formatSince(date: Date | string | undefined, locale: string, now: number = Date.now()): string | null {
  if (!date) return null;
  const ms = now - new Date(date).getTime();
  if (!Number.isFinite(ms)) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return rtf.format(0, 'second');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, 'day');
  return new Date(date).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
