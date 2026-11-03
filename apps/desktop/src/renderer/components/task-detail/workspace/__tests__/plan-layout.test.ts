import { describe, it, expect } from 'vitest';
import type { WorkspacePlan, WorkspacePlanSubtask } from '../../../../../shared/types';
import { bestDirection, layoutPlan, localDepths, nodeHeight, NODE_GAP_X, NODE_HEIGHT, NODE_WIDTH, PHASE_PADDING } from '../plan-layout';

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
    expect(layoutPlan({ phases: [] })).toEqual({ direction: 'TB', phases: [], width: 0, height: 0 });
  });
});

describe('layoutPlan directions and node sizes', () => {
  const longTitle = 'Create and run the initial migration with every table, index and constraint';
  const plan: WorkspacePlan = {
    phases: [
      { id: 'p1', name: 'One', dependsOn: [], subtasks: [{ ...st('a', 'p1'), title: longTitle, acIds: ['AC-1', 'AC-5', 'AC-6', 'AC-12', 'AC-15', 'AC-17'] }] },
      { id: 'p2', name: 'Two', dependsOn: ['p1'], subtasks: [st('b', 'p2', ['a']), st('c', 'p2')] },
      { id: 'p3', name: 'Three', dependsOn: ['p2'], subtasks: [st('d', 'p3', ['c'])] },
    ],
  };

  it('makes a node tall enough for a long title and two rows of AC chips', () => {
    const short = nodeHeight({ title: 'x', acIds: [] });
    const long = nodeHeight({ title: longTitle, acIds: ['AC-1', 'AC-5', 'AC-6', 'AC-12', 'AC-15', 'AC-17'] });
    expect(short).toBe(NODE_HEIGHT);
    // 3 title lines + 2 chip rows (6 chips do not fit one row in the node width)
    expect(long).toBeGreaterThanOrEqual(10 * 2 + 16 + 6 + 3 * 18 + 6 + 2 * 18 + 4);
    const layout = layoutPlan(plan, 'TB');
    const a = layout.phases[0].subtasks[0];
    expect(a.height).toBe(long);
    expect(layout.phases[0].height).toBeGreaterThanOrEqual(a.y + a.height);
  });

  it('LR puts phases side by side, TB stacks them; stacked nodes never overlap', () => {
    const lr = layoutPlan(plan, 'LR');
    expect(lr.phases[1].x).toBeGreaterThan(lr.phases[0].x + lr.phases[0].width);
    expect(lr.phases.every((p) => p.y === 0)).toBe(true);
    const tb = layoutPlan(plan, 'TB');
    expect(tb.phases[1].y).toBeGreaterThan(tb.phases[0].y + tb.phases[0].height);
    const [b, c] = tb.phases[1].subtasks;
    expect(c.y).toBeGreaterThanOrEqual(b.y + b.height);
  });

  it('picks the direction that fits the panel better', () => {
    expect(bestDirection(plan, 1200, 600)).toBe('LR');
    expect(bestDirection(plan, 300, 2000)).toBe('TB');
    expect(bestDirection({ phases: [plan.phases[0]] }, 1200, 600)).toBe('TB');
  });
});
