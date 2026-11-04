import { describe, expect, it } from 'vitest';

import type { Task } from '../../../../shared/types';
import { countSubtasks, formatSince, getTaskStage, planningSubStage } from '../task-stage';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    specId: '001-x',
    projectId: 'p',
    title: 'X',
    description: '',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const sub = (status: 'pending' | 'in_progress' | 'completed' | 'failed', id = Math.random().toString(36)) => ({
  id,
  title: id,
  description: '',
  status,
  files: [],
});

describe('planningSubStage', () => {
  it('reads the orchestrator messages', () => {
    expect(planningSubStage('Spec creation: requirements (2/5)', false)).toBe('spec');
    expect(planningSubStage('Designing the architecture', false)).toBe('architect');
    expect(planningSubStage('Creating implementation plan', false)).toBe('planner');
    expect(planningSubStage('Iteration 3 (planning)', false)).toBe('planner');
  });

  it('falls back on whether a plan exists', () => {
    expect(planningSubStage(undefined, false)).toBe('spec');
    expect(planningSubStage('', true)).toBe('planner');
  });
});

describe('getTaskStage', () => {
  it('backlog task has nothing current', () => {
    const info = getTaskStage(task());
    expect(info.current).toBeNull();
    expect(info.running).toBe(false);
    expect(Object.values(info.states).every((s) => s === 'upcoming')).toBe(true);
  });

  it('a queued task with a plan has passed spec → plan', () => {
    const info = getTaskStage(task({ status: 'queue', subtasks: [sub('pending')] }));
    expect(info.current).toBeNull();
    expect(info.states.spec).toBe('done');
    expect(info.states.planner).toBe('done');
    expect(info.states.coder).toBe('upcoming');
  });

  it('architect is current while the architecture is designed', () => {
    const info = getTaskStage(
      task({ status: 'in_progress', executionProgress: { phase: 'planning', phaseProgress: 0, overallProgress: 0, message: 'Designing the architecture' } })
    );
    expect(info.current).toBe('architect');
    expect(info.agent).toBe('architect');
    expect(info.running).toBe(true);
    expect(info.states.spec).toBe('done');
    expect(info.states.planner).toBe('upcoming');
  });

  it('coding is the coder stage; pauses are flagged and not running', () => {
    const coding = getTaskStage(task({ status: 'in_progress', executionProgress: { phase: 'coding', phaseProgress: 0, overallProgress: 0 } }));
    expect(coding.current).toBe('coder');
    expect(coding.running).toBe(true);
    const paused = getTaskStage(
      task({ status: 'in_progress', executionProgress: { phase: 'rate_limit_paused', phaseProgress: 0, overallProgress: 0 } })
    );
    expect(paused.current).toBe('coder');
    expect(paused.running).toBe(false);
    expect(paused.paused).toBe('rate_limit');
  });

  it('QA fixing keeps the QA stage with the fixer at work', () => {
    const info = getTaskStage(task({ status: 'in_progress', executionProgress: { phase: 'qa_fixing', phaseProgress: 0, overallProgress: 0 } }));
    expect(info.current).toBe('qa');
    expect(info.agent).toBe('qaFixer');
  });

  it('ai_review is QA running', () => {
    const info = getTaskStage(task({ status: 'ai_review' }));
    expect(info.current).toBe('qa');
    expect(info.running).toBe(true);
  });

  it('human review: QA rejection marks QA as the stage that sent it back', () => {
    const info = getTaskStage(task({ status: 'human_review', reviewReason: 'qa_rejected' }));
    expect(info.current).toBe('review');
    expect(info.agent).toBe('you');
    expect(info.states.qa).toBe('failed');
    expect(info.states.coder).toBe('done');
  });

  it('human review with errors marks the coder', () => {
    const info = getTaskStage(task({ status: 'human_review', reviewReason: 'errors' }));
    expect(info.states.coder).toBe('failed');
    // QA never ran
    expect(info.states.qa).toBe('upcoming');
  });

  it('errors after coding finished are QA not approving, not the code', () => {
    const sub = (id: string) => ({ id, title: id, description: '', status: 'completed', files: [] }) as unknown as Task['subtasks'][number];
    const byPhase = getTaskStage(task({ status: 'human_review', reviewReason: 'errors', executionProgress: { phase: 'failed', phaseProgress: 0, overallProgress: 0, completedPhases: ['planning', 'coding'] } }));
    expect(byPhase.states.coder).toBe('done');
    expect(byPhase.states.qa).toBe('failed');
    const bySubtasks = getTaskStage(task({ status: 'human_review', reviewReason: 'errors', subtasks: [sub('1'), sub('2')] }));
    expect(bySubtasks.states.qa).toBe('failed');
    expect(bySubtasks.states.coder).toBe('done');
  });

  it('plan review leaves code and QA ahead', () => {
    const info = getTaskStage(task({ status: 'human_review', reviewReason: 'plan_review' }));
    expect(info.current).toBe('review');
    expect(info.states.planner).toBe('done');
    expect(info.states.coder).toBe('upcoming');
    expect(info.states.qa).toBe('upcoming');
  });

  it('a stopped task only marks the stages its recorded phases prove', () => {
    const info = getTaskStage(
      task({
        status: 'human_review',
        reviewReason: 'stopped',
        executionProgress: { phase: 'idle', phaseProgress: 0, overallProgress: 0, completedPhases: ['planning'] },
      })
    );
    expect(info.states.planner).toBe('done');
    expect(info.states.coder).toBe('upcoming');
    expect(info.states.review).toBe('current');
  });

  it('done and PR created pass every stage', () => {
    for (const status of ['done', 'pr_created'] as const) {
      const info = getTaskStage(task({ status }));
      expect(info.finished).toBe(true);
      expect(Object.values(info.states).every((s) => s === 'done')).toBe(true);
    }
  });
});

describe('countSubtasks', () => {
  it('counts by status', () => {
    expect(countSubtasks(task({ subtasks: [sub('completed'), sub('completed'), sub('in_progress'), sub('failed'), sub('pending')] }))).toEqual({
      done: 2,
      total: 5,
      failed: 1,
      inProgress: 1,
    });
  });
});

describe('formatSince', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  it('uses the locale', () => {
    // Compare with Intl itself: the exact wording depends on the ICU version
    const rtf = (locale: string) => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    expect(formatSince(new Date(now - 5 * 60_000), 'en', now)).toBe(rtf('en').format(-5, 'minute'));
    expect(formatSince(new Date(now - 3 * 3_600_000), 'uk', now)).toBe(rtf('uk').format(-3, 'hour'));
    expect(formatSince(new Date(now - 10_000), 'en', now)).toBe(rtf('en').format(0, 'second'));
  });
  it('returns null without a valid date', () => {
    expect(formatSince(undefined, 'en', now)).toBeNull();
    expect(formatSince('nope', 'en', now)).toBeNull();
  });
});
