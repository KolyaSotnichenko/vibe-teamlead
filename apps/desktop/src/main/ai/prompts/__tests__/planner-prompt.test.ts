import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const planner = readFileSync(resolve(__dirname, '../../../../../prompts/planner.md'), 'utf-8');

describe('planner prompt', () => {
  it('checks for existing code before adding a subtask: each one costs a whole coder session', () => {
    expect(planner).toMatch(/Reuse before you add/);
  });

  it('merges only what is tiny: a long session costs more per turn, so big merged subtasks cost more, not less', () => {
    expect(planner).toMatch(/Merge only what is tiny/);
    expect(planner).toMatch(/Each subtask should take 1-3 files max/);
  });

  it('none of it can drop a criterion', () => {
    expect(planner).toMatch(/No AC may be left unmapped/);
    expect(planner).toMatch(/never a reason to leave an AC unmapped/);
  });
});
