import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { architectModeFor, complexityOverrideFor, readComplexityOverride, readTaskMetadata } from '../quick-fix';

describe('Quick fix from preview notes', () => {
  it('runs the simple spec path only for a task made from preview notes as a quick fix', () => {
    expect(complexityOverrideFor({ previewQuickFix: true })).toBe('simple');
    expect(complexityOverrideFor({ previewQuickFix: 'yes' })).toBeUndefined();
    expect(complexityOverrideFor({ complexity: 'trivial' })).toBeUndefined();
    expect(complexityOverrideFor(null)).toBeUndefined();
  });

  it("reads it from the task's metadata file, and nothing when there is none", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-qf-'));
    expect(await readComplexityOverride(dir)).toBeUndefined();
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ previewQuickFix: true }));
    expect(await readComplexityOverride(dir)).toBe('simple');
  });
});

describe('Cloud architecture design task (Context → Architecture)', () => {
  it('runs the standard spec path with the architect, unless the architect is turned off', async () => {
    expect(complexityOverrideFor({ cloudArchitectureDesign: true })).toBe('standard');
    expect(architectModeFor({ cloudArchitectureDesign: true }, 'complex')).toBe('always');
    expect(architectModeFor({ cloudArchitectureDesign: true }, 'never')).toBe('never');
    expect(architectModeFor({}, 'complex')).toBe('complex');
    expect(architectModeFor(undefined, undefined)).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'vtl-qf-'));
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ cloudArchitectureDesign: true }));
    expect(await readTaskMetadata(dir)).toEqual({ cloudArchitectureDesign: true });
  });
});
