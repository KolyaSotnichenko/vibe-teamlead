import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { applyFailedSubtaskDecision, parseFailedSubtaskDecision } from '../failed-subtask-decision';
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
    expect(readOwnerDecisions(decisions).skipped).toEqual(['s2']);
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
    expect(readOwnerDecisions(decisions).instructions).toEqual({ s2: 'go' });

    expect(await applyFailedSubtaskDecision([join(root, 'nope', 'implementation_plan.json'), main], { action: 'skip' }, decisions)).toEqual({ changed: [] });
    expect(readOwnerDecisions(decisions).instructions).toEqual({ s2: 'go' });
  });
});

describe('parseFailedSubtaskDecision', () => {
  it('accepts skip and retry, drops an instruction that is not text, and rejects anything else', () => {
    expect(parseFailedSubtaskDecision({ action: 'skip', instruction: 'x' })).toEqual({ action: 'skip' });
    expect(parseFailedSubtaskDecision({ action: 'retry', instruction: 'fix it' })).toEqual({ action: 'retry', instruction: 'fix it' });
    expect(parseFailedSubtaskDecision({ action: 'retry', instruction: 5 })).toEqual({ action: 'retry', instruction: undefined });
    expect(parseFailedSubtaskDecision({ action: 'delete' })).toBeNull();
    expect(parseFailedSubtaskDecision('skip')).toBeNull();
  });
});
