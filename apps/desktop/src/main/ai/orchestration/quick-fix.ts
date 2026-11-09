/**
 * Quick fix: a task made from Preview notes with "Quick fix" chosen runs the spec
 * pipeline's simple path (quick_spec, no discovery, requirements or separate planner),
 * skipping the complexity assessment. Only these tasks: task complexity still means
 * nothing to the pipeline for every other task.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComplexityTier } from './spec-orchestrator';

/** Pure. */
export function complexityOverrideFor(metadata: unknown): ComplexityTier | undefined {
  return metadata && typeof metadata === 'object' && (metadata as { previewQuickFix?: unknown }).previewQuickFix === true ? 'simple' : undefined;
}

export async function readComplexityOverride(specDir: string): Promise<ComplexityTier | undefined> {
  try {
    return complexityOverrideFor(JSON.parse(await readFile(join(specDir, 'task_metadata.json'), 'utf-8')));
  } catch {
    return undefined;
  }
}
