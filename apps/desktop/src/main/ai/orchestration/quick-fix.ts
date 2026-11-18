/**
 * Spec paths chosen by the task itself, skipping the complexity assessment:
 *
 * - Quick fix: a task made from Preview notes with "Quick fix" chosen runs the
 *   simple path (quick_spec, no discovery, requirements or separate planner).
 * - Cloud architecture design (Context → Architecture): the standard path with
 *   the architect (unless the Architect setting is "never"), so the architect
 *   draws the target cloud architecture with TerraVision.
 *
 * Only these tasks: task complexity still means nothing to the pipeline for every other task.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ArchitectMode } from '../../../shared/types/settings';
import type { ComplexityTier } from './spec-orchestrator';

const flag = (metadata: unknown, name: string) => !!metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>)[name] === true;

/** Pure. */
export function complexityOverrideFor(metadata: unknown): ComplexityTier | undefined {
  if (flag(metadata, 'previewQuickFix')) return 'simple';
  if (flag(metadata, 'cloudArchitectureDesign')) return 'standard';
  return undefined;
}

/** The architect always runs for a cloud architecture design task, unless it is turned off. Pure. */
export function architectModeFor(metadata: unknown, mode: ArchitectMode | undefined): ArchitectMode | undefined {
  return flag(metadata, 'cloudArchitectureDesign') && mode !== 'never' ? 'always' : mode;
}

export async function readTaskMetadata(specDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(specDir, 'task_metadata.json'), 'utf-8'));
  } catch {
    return undefined;
  }
}

export async function readComplexityOverride(specDir: string): Promise<ComplexityTier | undefined> {
  return complexityOverrideFor(await readTaskMetadata(specDir));
}
