import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import { isAtCapacity, MAX_PARALLEL_TASKS, occupiesSlot, parallelTaskLimit, slotHolders, slotHolderLabels } from '../task-slots';

const task = (id: string, status: string, metadata = {}) => ({ id, specId: `${id}-name`, status, metadata }) as unknown as Task;

describe('how many tasks may run', () => {
  it('is one unless the project asks for more', () => {
    expect(parallelTaskLimit(undefined)).toBe(1);
    expect(parallelTaskLimit(2)).toBe(2);
  });

  it('holds a project that saved more to the new maximum', () => {
    expect(MAX_PARALLEL_TASKS).toBe(3);
    expect(parallelTaskLimit(10)).toBe(3);
  });

  it('never lets a bad value stop the queue for good', () => {
    expect(parallelTaskLimit(0)).toBe(1);
    expect(parallelTaskLimit(-2)).toBe(1);
    expect(parallelTaskLimit(Number.NaN)).toBe(1);
  });
});

describe('what holds a slot', () => {
  it.each(['in_progress', 'ai_review', 'human_review', 'error'])('a task not merged yet: %s', (status) => {
    expect(occupiesSlot(task('1', status))).toBe(true);
  });

  it.each(['backlog', 'queue', 'done', 'pr_created'])('not a task that has not started or is finished: %s', (status) => {
    expect(occupiesSlot(task('1', status))).toBe(false);
  });

  it('not an archived task, wherever it stood', () => {
    expect(occupiesSlot(task('1', 'human_review', { archivedAt: 'now' }))).toBe(false);
  });

  it('names who holds them, by spec number', () => {
    expect(slotHolders([task('011', 'human_review'), task('021', 'queue'), task('020', 'in_progress')])).toEqual(['011', '020']);
  });
});

describe('whether a slot is free', () => {
  const unmerged = task('a', 'human_review');
  const queued = task('b', 'queue');

  it('a task waiting for review keeps the next one in the queue: both would start from the same main', () => {
    expect(isAtCapacity([unmerged, queued], 1)).toBe(true);
  });

  it('frees up on merge', () => {
    expect(isAtCapacity([task('a', 'done'), queued], 1)).toBe(false);
  });

  it('leaves room up to the limit', () => {
    expect(isAtCapacity([unmerged, queued], 2)).toBe(false);
  });

  it('never sends a task that already holds a slot to the queue: resuming it starts nothing new', () => {
    expect(isAtCapacity([unmerged, task('c', 'in_progress')], 1, 'a')).toBe(false);
  });

  it('counts the others for a task that does not hold one yet', () => {
    expect(isAtCapacity([unmerged, queued], 1, 'b')).toBe(true);
  });
});

describe('what the queue waits for', () => {
  it('names a task held for the preview as waiting for the owner', () => {
    const held = { ...task('011', 'human_review'), reviewReason: 'completed', waitingForPreview: true } as unknown as Task;
    const stale = { ...task('012', 'in_progress'), waitingForPreview: true } as unknown as Task;
    expect(slotHolderLabels([held, stale, task('020', 'in_progress')], (n) => `${n} (your preview)`)).toEqual(['011 (your preview)', '012', '020']);
  });
});
