import { describe, expect, it } from 'vitest';
import type { Task } from '../../../shared/types';
import { hasNothingBuilt, isIncompleteHumanReview } from '../task-store';

const task = (reviewReason: string | undefined, statuses: string[]) =>
  ({ status: 'human_review', reviewReason, subtasks: statuses.map((status, i) => ({ id: `s${i}`, status })) }) as unknown as Task;

describe('isIncompleteHumanReview', () => {
  it('offers resume when a run ended in an error before any subtask was done', () => {
    expect(isIncompleteHumanReview(task('errors', ['pending', 'pending']))).toBe(true);
  });

  it('offers to resume a run that stopped partway through the plan', () => {
    expect(isIncompleteHumanReview(task('errors', ['completed', 'pending']))).toBe(true);
  });

  it('keeps errors after the whole plan was built in review: QA is what failed', () => {
    expect(isIncompleteHumanReview(task('errors', ['completed', 'completed']))).toBe(false);
  });

  it('tells a run with some code from one with none, which has nothing to review', () => {
    expect(hasNothingBuilt(task('errors', ['pending', 'pending']))).toBe(true);
    expect(hasNothingBuilt(task('errors', ['completed', 'pending']))).toBe(false);
    expect(hasNothingBuilt(task('errors', ['completed', 'completed']))).toBe(false);
  });

  it('has no plan to resume from after an error without subtasks', () => {
    expect(isIncompleteHumanReview(task('errors', []))).toBe(false);
  });

  it('leaves reviews placed on purpose alone', () => {
    for (const reason of ['plan_review', 'completed', 'qa_rejected', 'stopped']) {
      expect(isIncompleteHumanReview(task(reason, ['pending'])), reason).toBe(false);
    }
  });

  it('still treats a review with no reason and no finished subtasks as a crash', () => {
    expect(isIncompleteHumanReview(task(undefined, ['pending']))).toBe(true);
    expect(isIncompleteHumanReview(task(undefined, []))).toBe(true);
  });
});
