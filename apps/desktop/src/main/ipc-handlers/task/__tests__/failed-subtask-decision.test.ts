import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn((_name: string) => process.env.TMPDIR ?? '/tmp') }));
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }));

import { applyFailedSubtaskDecision, parseFailedSubtaskDecision, taskOwnerDecisionsFile } from '../failed-subtask-decision';
import { readOwnerDecisions } from '../../../ai/orchestration/owner-decisions';

const PLAN = { status: 'human_review', phases: [{ name: 'P', subtasks: [{ id: 's1', status: 'completed' }, { id: 's2', status: 'failed', notes: 'why' }] }] };

function planAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'implementation_plan.json');
  writeFileSync(path, JSON.stringify(PLAN));
  return path;
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf-8'));

describe('applyFailedSubtaskDecision', () => {
  it('writes the decision to every copy of the plan, worktree and main', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-decision-'));
    const worktree = planAt(join(root, 'wt'));
    const main = planAt(join(root, 'main'));

    const decisions = join(root, 'data', 'decisions.json');
    const result = await applyFailedSubtaskDecision([worktree, main], { action: 'skip' }, decisions);

    expect(result).toEqual({ changed: ['s2'] });
    expect(Object.keys(readOwnerDecisions(decisions).skipped)).toEqual(['s2']);
    for (const path of [worktree, main]) {
      expect(read(path).phases[0].subtasks[1]).toMatchObject({ status: 'completed', skipped_by_owner: true, notes: 'why' });
    }
  });

  it('skips a copy that is missing, and reports nothing changed when no subtask failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-decision-'));
    const main = planAt(join(root, 'main'));
    const decisions = join(root, 'decisions.json');
    await applyFailedSubtaskDecision([main], { action: 'retry', instruction: 'go' }, decisions);
    expect(read(main).phases[0].subtasks[1]).toMatchObject({ status: 'pending' });
    expect(readOwnerDecisions(decisions).instructions.s2.text).toBe('go');

    expect(await applyFailedSubtaskDecision([join(root, 'nope', 'implementation_plan.json'), main], { action: 'skip' }, decisions)).toEqual({ changed: [] });
    expect(readOwnerDecisions(decisions).instructions.s2.text).toBe('go');
  });
});

describe('parseFailedSubtaskDecision', () => {
  it('accepts skip and retry, drops an instruction that is not text, and rejects anything else', () => {
    expect(parseFailedSubtaskDecision({ action: 'skip', instruction: 'x', ids: ['s2'] })).toEqual({ action: 'skip', ids: ['s2'] });
    expect(parseFailedSubtaskDecision({ action: 'retry', instruction: 'fix it', ids: ['s2'] })).toEqual({ action: 'retry', instruction: 'fix it', ids: ['s2'] });
    expect(parseFailedSubtaskDecision({ action: 'retry', instruction: 5, ids: ['s2'] })).toEqual({ action: 'retry', instruction: undefined, ids: ['s2'] });
    expect(parseFailedSubtaskDecision({ action: 'delete', ids: ['s2'] })).toBeNull();
    expect(parseFailedSubtaskDecision({ action: 'skip' })).toBeNull();
    expect(parseFailedSubtaskDecision({ action: 'skip', ids: [] })).toBeNull();
    expect(parseFailedSubtaskDecision({ action: 'skip', ids: [5] })).toBeNull();
    expect(parseFailedSubtaskDecision('skip')).toBeNull();
  });
});

describe('taskOwnerDecisionsFile', () => {
  it("is in the app's data, and undefined (no decisions trusted) when that folder can't be found", () => {
    expect(taskOwnerDecisionsFile('/p/specs/023')).toMatch(/\/owner-decisions\/[0-9a-f]{24}\.json$/);
    getPath.mockImplementationOnce(() => {
      throw new Error('no app');
    });
    expect(taskOwnerDecisionsFile('/p/specs/023')).toBeUndefined();
  });
});
