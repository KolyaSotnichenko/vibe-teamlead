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
 *
 * Architecture-only (architectureOnly in the metadata, set by Context → Architecture's
 * button): the spec ends after the architect, and the task then waits in Human Review
 * as "architecture ready" — no planner, coder, QA, app checks or merge.
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

/** Marked by its metadata, never guessed from text. Pure. */
export function architectureOnlyFor(metadata: unknown): boolean {
  return flag(metadata, 'architectureOnly');
}

/** What follows a spec-creation process that exited with this code. Pure. */
export function afterSpecCreation(metadata: unknown, exitCode: number | null): 'build' | 'architecture_ready' | 'none' {
  if (exitCode !== 0) return 'none';
  return architectureOnlyFor(metadata) ? 'architecture_ready' : 'build';
}

/** The agentic spec mode has no fixed end, so an architecture-only task runs the phase pipeline. Pure. */
export function agenticSpecFor(agentic: boolean | undefined, metadata: unknown): boolean {
  return !!agentic && !architectureOnlyFor(metadata);
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
