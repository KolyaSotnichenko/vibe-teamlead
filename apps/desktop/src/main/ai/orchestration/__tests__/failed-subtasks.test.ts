import { describe, expect, it } from 'vitest';

import { resolveFailedSubtasks, subtaskFingerprint } from '../failed-subtasks';

const NOW = '2026-11-09T12:00:00.000Z';
const plan = () => ({
  phases: [
    {
      name: 'P',
      subtasks: [
        { id: 's1', description: 'done', status: 'completed' },
        { id: 's2', description: 'run suite', status: 'failed', notes: 'Needs a product fix' },
        { id: 's3', description: 'other', status: 'blocked' },
        { id: 's4', description: 'later', status: 'pending' },
      ],
    },
  ],
});

describe('resolveFailedSubtasks', () => {
  it('skip: marks the subtasks the coder gave up on done by the owner, keeping its notes, and leaves the rest', () => {
    const { plan: out, changed } = resolveFailedSubtasks(plan(), { action: 'skip' }, NOW);
    const [s1, s2, s3, s4] = out.phases[0].subtasks;
    expect(changed.map((c) => c.id)).toEqual(['s2', 's3']);
    expect(s2).toMatchObject({ status: 'completed', skipped_by_owner: true, completed_at: NOW, notes: 'Needs a product fix' });
    expect(s3).toMatchObject({ status: 'completed', skipped_by_owner: true });
    expect(s1).toEqual({ id: 's1', description: 'done', status: 'completed' });
    expect(s4.status).toBe('pending');
  });

  it('retry: reopens them, and writes no instruction into the plan agents can edit', () => {
    const p = plan();
    (p.phases[0].subtasks[1] as Record<string, unknown>).skipped_by_owner = true;
    const { plan: out, changed } = resolveFailedSubtasks(p, { action: 'retry', instruction: 'You may change product code.' }, NOW);
    const s2 = out.phases[0].subtasks[1];
    expect(changed.map((c) => c.id)).toEqual(['s2', 's3']);
    expect(s2).toMatchObject({ status: 'pending', notes: 'Needs a product fix' });
    expect(s2).not.toHaveProperty('skipped_by_owner');
    expect(JSON.stringify(out)).not.toContain('You may change product code.');
  });

  it('changes nothing when no subtask failed, and survives a plan without phases', () => {
    expect(resolveFailedSubtasks({ phases: [{ name: 'P', subtasks: [{ id: 'a', status: 'completed' }] }] }, { action: 'skip' }, NOW).changed).toEqual([]);
    expect(resolveFailedSubtasks({} as never, { action: 'skip' }, NOW).changed).toEqual([]);
  });
});

describe('binding a decision to what the owner saw', () => {
  it('acts only on the subtasks the owner was shown, and returns their fingerprints', () => {
    const { plan: out, changed } = resolveFailedSubtasks(plan(), { action: 'skip', ids: ['s2'] }, NOW);
    expect(changed).toEqual([{ id: 's2', fingerprint: subtaskFingerprint({ description: 'run suite' }) }]);
    expect(out.phases[0].subtasks[2].status).toBe('blocked');
  });

  it('fingerprints title and description, so a rewritten subtask no longer matches', () => {
    expect(subtaskFingerprint({ title: 'A', description: 'x' })).toBe(subtaskFingerprint({ title: 'A', description: 'x' }));
    expect(subtaskFingerprint({ title: 'A', description: 'x' })).not.toBe(subtaskFingerprint({ title: 'A', description: 'x and more' }));
    expect(subtaskFingerprint({ title: 'Ax', description: '' })).not.toBe(subtaskFingerprint({ title: 'A', description: 'x' }));
  });
});
