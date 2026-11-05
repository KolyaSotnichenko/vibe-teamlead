import { describe, expect, it } from 'vitest';
import type { Task } from '../../../shared/types';
import { isIncompleteHumanReview } from '../task-store';

const task = (reviewReason: string | undefined, statuses: string[]) =>
  ({ status: 'human_review', reviewReason, subtasks: statuses.map((status, i) => ({ id: `s${i}`, status })) }) as unknown as Task;

describe('isIncompleteHumanReview', () => {
  it('offers resume when a run ended in an error before any subtask was done', () => {
    expect(isIncompleteHumanReview(task('errors', ['pending', 'pending']))).toBe(true);
  });

  it('keeps QA errors on built code in review', () => {
    expect(isIncompleteHumanReview(task('errors', ['completed', 'pending']))).toBe(false);
    expect(isIncompleteHumanReview(task('errors', ['completed', 'completed']))).toBe(false);
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
