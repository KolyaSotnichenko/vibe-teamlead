import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { markWaitingForPreview } from '../preview-hold';

describe('markWaitingForPreview', () => {
  it('marks every copy of the plan, and clears the mark again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-hold-'));
    const plan = join(dir, 'implementation_plan.json');
    writeFileSync(plan, JSON.stringify({ phases: [] }));
    await markWaitingForPreview([plan, join(dir, 'missing.json')]);
    expect(JSON.parse(readFileSync(plan, 'utf-8')).waitingForPreview).toBe(true);
    await markWaitingForPreview([plan], false);
    expect(JSON.parse(readFileSync(plan, 'utf-8'))).not.toHaveProperty('waitingForPreview');
  });
});
