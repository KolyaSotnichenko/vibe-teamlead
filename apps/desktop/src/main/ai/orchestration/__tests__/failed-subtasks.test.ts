import { describe, expect, it } from 'vitest';

import { resolveFailedSubtasks } from '../failed-subtasks';

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
    expect(changed).toEqual(['s2', 's3']);
    expect(s2).toMatchObject({ status: 'completed', skipped_by_owner: true, completed_at: NOW, notes: 'Needs a product fix' });
    expect(s3).toMatchObject({ status: 'completed', skipped_by_owner: true });
    expect(s1).toEqual({ id: 's1', description: 'done', status: 'completed' });
    expect(s4.status).toBe('pending');
  });

  it('retry: reopens them with the owner instruction, trimmed', () => {
    const { plan: out, changed } = resolveFailedSubtasks(plan(), { action: 'retry', instruction: '  You may change product code.  ' }, NOW);
    const s2 = out.phases[0].subtasks[1];
    expect(changed).toEqual(['s2', 's3']);
    expect(s2).toMatchObject({ status: 'pending', owner_instruction: 'You may change product code.', notes: 'Needs a product fix' });
    expect(s2).not.toHaveProperty('skipped_by_owner');
  });

  it('retry without an instruction drops an old one', () => {
    const p = plan();
    (p.phases[0].subtasks[1] as Record<string, unknown>).owner_instruction = 'old';
    const s2 = resolveFailedSubtasks(p, { action: 'retry', instruction: '   ' }, NOW).plan.phases[0].subtasks[1];
    expect(s2).not.toHaveProperty('owner_instruction');
  });

  it('caps a long instruction', () => {
    const s2 = resolveFailedSubtasks(plan(), { action: 'retry', instruction: 'x'.repeat(10_000) }, NOW).plan.phases[0].subtasks[1];
    expect(((s2 as Record<string, unknown>).owner_instruction as string).length).toBe(4000);
  });

  it('changes nothing when no subtask failed, and survives a plan without phases', () => {
    expect(resolveFailedSubtasks({ phases: [{ name: 'P', subtasks: [{ id: 'a', status: 'completed' }] }] }, { action: 'skip' }, NOW).changed).toEqual([]);
    expect(resolveFailedSubtasks({} as never, { action: 'skip' }, NOW).changed).toEqual([]);
  });
});
