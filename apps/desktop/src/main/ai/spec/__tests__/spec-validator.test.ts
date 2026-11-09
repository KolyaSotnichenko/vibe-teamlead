import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateImplementationPlan } from '../spec-validator';

function planWith(verification: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-specval-'));
  writeFileSync(
    join(dir, 'implementation_plan.json'),
    JSON.stringify({ feature: 'x', workflow_type: 'feature', phases: [{ id: 'p1', name: 'P', subtasks: [{ id: '1-1', title: 'T', description: 'D', status: 'pending', verification }] }] }),
  );
  return dir;
}

describe('validateImplementationPlan and a subtask verification', () => {
  it('accepts one written as a string, which the plan schema turns into a check (task 028)', () => {
    const result = validateImplementationPlan(planWith('pnpm --filter @roadmaply/web test'));
    expect(result.errors.filter((e) => /verification/i.test(e))).toEqual([]);
  });

  it('still names an object without a type, or with an unknown one', () => {
    expect(validateImplementationPlan(planWith({ run: 'x' })).errors.join(' ')).toMatch(/verification missing 'type'/);
    expect(validateImplementationPlan(planWith({ type: 'telepathy' })).errors.join(' ')).toMatch(/invalid verification type/);
  });
});
