import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { afterSpecCreation, architectModeFor, architectureOnlyFor, complexityOverrideFor, readComplexityOverride, readTaskMetadata, agenticSpecFor } from '../quick-fix';

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

describe('Architecture-only task', () => {
  it('is marked by its metadata, never guessed from text', () => {
    expect(architectureOnlyFor({ architectureOnly: true })).toBe(true);
    expect(architectureOnlyFor({ architectureOnly: 'yes' })).toBe(false);
    expect(architectureOnlyFor({ cloudArchitectureDesign: true })).toBe(false);
    expect(architectureOnlyFor({ title: 'architecture only' })).toBe(false);
    expect(architectureOnlyFor(undefined)).toBe(false);
  });

  it('after a successful spec, ends at "architecture ready" instead of starting the build', () => {
    expect(afterSpecCreation({ architectureOnly: true }, 0)).toBe('architecture_ready');
    expect(afterSpecCreation({}, 0)).toBe('build');
    expect(afterSpecCreation(undefined, 0)).toBe('build');
    expect(afterSpecCreation({ architectureOnly: true }, 1)).toBe('none');
    expect(afterSpecCreation({}, 1)).toBe('none');
    expect(afterSpecCreation({}, null)).toBe('none');
  });
});

describe('Agentic spec mode and architecture-only tasks', () => {
  it('runs an architecture-only task on the phase pipeline, which can stop after the architect', () => {
    expect(agenticSpecFor(true, { architectureOnly: true })).toBe(false);
    expect(agenticSpecFor(true, {})).toBe(true);
    expect(agenticSpecFor(false, {})).toBe(false);
    expect(agenticSpecFor(undefined, undefined)).toBe(false);
  });
});
