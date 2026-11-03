import { describe, it, expect } from 'vitest';
import type { WorkspacePlan, WorkspacePlanSubtask } from '../../../../../shared/types';
import { layoutPlan, localDepths, NODE_GAP_X, NODE_WIDTH, PHASE_PADDING } from '../plan-layout';

const st = (id: string, phaseId: string, dependsOn: string[] = []): WorkspacePlanSubtask => ({
  id,
  title: id,
  description: '',
  status: 'pending',
  phaseId,
  acIds: [],
  dependsOn,
  files: [],
});

describe('localDepths', () => {
  it('uses same-phase dependencies only and survives cycles', () => {
    const depths = localDepths([st('a', 'p'), st('b', 'p', ['a']), st('c', 'p', ['b', 'outside']), st('x', 'p', ['y']), st('y', 'p', ['x'])]);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
    expect(depths.get('x')).toBeGreaterThanOrEqual(0);
  });
});

describe('layoutPlan', () => {
  it('stacks phases top to bottom and places subtasks by depth', () => {
    const plan: WorkspacePlan = {
      phases: [
        { id: 'p1', name: 'One', dependsOn: [], subtasks: [st('a', 'p1'), st('b', 'p1', ['a']), st('c', 'p1')] },
        { id: 'p2', name: 'Two', dependsOn: ['p1'], subtasks: [st('d', 'p2', ['b'])] },
      ],
    };
    const layout = layoutPlan(plan);
    const [p1, p2] = layout.phases;
    expect(p1.width).toBe(PHASE_PADDING * 2 + 2 * NODE_WIDTH + NODE_GAP_X);
    expect(p2.width).toBe(p1.width);
    expect(p2.y).toBeGreaterThan(p1.y + p1.height);
    const pos = Object.fromEntries(p1.subtasks.map((s) => [s.subtask.id, s]));
    expect(pos.b.x).toBeGreaterThan(pos.a.x);
    expect(pos.c.x).toBe(pos.a.x);
    expect(pos.c.y).toBeGreaterThan(pos.a.y);
    expect(layout.height).toBe(p2.y + p2.height);
  });

  it('handles an empty plan', () => {
    expect(layoutPlan({ phases: [] })).toEqual({ phases: [], width: 0, height: 0 });
  });
});
