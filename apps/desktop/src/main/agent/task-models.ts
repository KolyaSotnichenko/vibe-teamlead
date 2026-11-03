/**
 * Make sure a task names its models before an agent runs.
 *
 * Tasks created without the wizard (spec document import, older tasks) have no
 * models in task_metadata.json; every phase then fell back to built-in Claude
 * models — which a custom endpoint (e.g. Ollama) does not serve. Before a run,
 * the user's current defaults (agent profile + custom phase models) are written
 * into the metadata, so the main process, the worker and its helper calls
 * (getPhaseModel / getPhaseThinking) all read the same models.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDefaultTaskModels } from '../../shared/utils/task-models';
import { isUsableModel } from '../ai/config/phase-config';
import { readSettingsFile } from '../settings-utils';

interface ModelMetadata {
  isAutoProfile?: boolean;
  model?: string;
  thinkingLevel?: string;
  phaseModels?: Record<string, string | undefined>;
  phaseThinking?: Record<string, string | undefined>;
  [key: string]: unknown;
}

const PHASES = ['spec', 'planning', 'coding', 'qa'] as const;

/** Whether the metadata already chose models (per phase, or one for all). */
export function hasTaskModels(metadata: ModelMetadata | null | undefined): boolean {
  if (!metadata) return false;
  if (metadata.phaseModels && PHASES.every((p) => isUsableModel(metadata.phaseModels?.[p]))) return true;
  return !metadata.isAutoProfile && isUsableModel(metadata.model);
}

/** Fill in missing models from the user's defaults; returns the metadata as written. */
export function withDefaultTaskModels(metadata: ModelMetadata, settings: Parameters<typeof resolveDefaultTaskModels>[0]): ModelMetadata {
  if (hasTaskModels(metadata)) return metadata;
  const defaults = resolveDefaultTaskModels(settings);
  return {
    ...metadata,
    isAutoProfile: true,
    model: defaults.model,
    thinkingLevel: metadata.thinkingLevel ?? defaults.thinkingLevel,
    phaseModels: defaults.phaseModels as unknown as Record<string, string>,
    phaseThinking: { ...(defaults.phaseThinking as unknown as Record<string, string>), ...(metadata.phaseThinking ?? {}) },
  };
}

/** Write the user's default models into the task's metadata if it has none. */
export function ensureTaskModels(specDir: string | undefined): void {
  if (!specDir) return;
  const metadataPath = path.join(specDir, 'task_metadata.json');
  let metadata: ModelMetadata = {};
  try {
    if (existsSync(metadataPath)) metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as ModelMetadata;
  } catch {
    return; // Unreadable metadata: leave it alone
  }
  if (hasTaskModels(metadata)) return;
  let settings: Parameters<typeof resolveDefaultTaskModels>[0];
  try {
    settings = readSettingsFile() as Parameters<typeof resolveDefaultTaskModels>[0];
  } catch {
    settings = undefined;
  }
  try {
    writeFileSync(metadataPath, `${JSON.stringify(withDefaultTaskModels(metadata, settings), null, 2)}\n`, 'utf-8');
  } catch {
    // Not writable: the run falls back to the built-in defaults
  }
}
