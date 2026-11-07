/**
 * Give a task its models before an agent runs.
 *
 * The models the user picked for a task stay. Every other task runs on what the
 * settings (agent profile + custom phase models) say now: they are written into
 * task_metadata.json before each run, so the main process, the worker and its
 * helper calls (getPhaseModel / getPhaseThinking) all read the same models, and
 * a run keeps them from start to finish. Without this, a task kept the models of
 * the day it was created, which a new provider may not serve at all.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDefaultTaskModels } from '../../shared/utils/task-models';
import { isUsableModel } from '../ai/config/phase-config';
import { writeFileReplacingSync } from '../ai/safe-write';
import { readSettingsFile } from '../settings-utils';

interface ModelMetadata {
  isAutoProfile?: boolean;
  modelsChosen?: boolean;
  model?: string;
  thinkingLevel?: string;
  phaseModels?: Record<string, string | undefined>;
  phaseThinking?: Record<string, string | undefined>;
  [key: string]: unknown;
}

const PHASES = ['spec', 'planning', 'coding', 'qa'] as const;
const MODEL_FIELDS = ['isAutoProfile', 'modelsChosen', 'model', 'thinkingLevel', 'phaseModels', 'phaseThinking'] as const;
const METADATA_FILE = 'task_metadata.json';

type ModelSettings = Parameters<typeof resolveDefaultTaskModels>[0];

function hasUsablePhaseModels(metadata: ModelMetadata): boolean {
  return Boolean(metadata.phaseModels) && PHASES.every((p) => isUsableModel(metadata.phaseModels?.[p]));
}

/** Whether the user picked this task's models: per phase in a form, or one for all phases. */
export function hasChosenModels(metadata: ModelMetadata | null | undefined): boolean {
  if (!metadata) return false;
  if (metadata.modelsChosen === true && hasUsablePhaseModels(metadata)) return true;
  return !metadata.isAutoProfile && isUsableModel(metadata.model);
}

/** The metadata with the models this task should run on. */
export function withDefaultTaskModels(metadata: ModelMetadata, settings: ModelSettings): ModelMetadata {
  if (hasChosenModels(metadata)) return metadata;
  const defaults = resolveDefaultTaskModels(settings);
  return {
    ...metadata,
    isAutoProfile: true,
    model: defaults.model,
    thinkingLevel: defaults.thinkingLevel,
    phaseModels: defaults.phaseModels as unknown as Record<string, string>,
    phaseThinking: defaults.phaseThinking as unknown as Record<string, string>,
  };
}

/** Like withDefaultTaskModels with the saved settings; settings that can't be read move nothing. */
export function taskModelsForRun(metadata: ModelMetadata): ModelMetadata {
  const settings = readSettingsFile() as ModelSettings;
  if (!settings && hasUsablePhaseModels(metadata)) return metadata;
  return withDefaultTaskModels(metadata, settings);
}

/**
 * Agents can reach these folders and leave a link in place of the file. It is
 * never read (the app would parse and rewrite what it points at), and the safe
 * write replaces the link itself.
 */
function isRealFile(file: string): boolean {
  return lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

/** Bring a task's metadata up to the models it should run on. */
export function ensureTaskModels(specDir: string | undefined): void {
  if (!specDir) return;
  const metadataPath = path.join(specDir, METADATA_FILE);
  let metadata: ModelMetadata = {};
  try {
    if (isRealFile(metadataPath)) metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as ModelMetadata;
  } catch {
    return; // Unreadable metadata: leave it alone
  }
  const next = taskModelsForRun(metadata);
  if (JSON.stringify(next) === JSON.stringify(metadata)) return;
  try {
    writeFileReplacingSync(metadataPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  } catch {
    // Not writable: the run falls back to the built-in defaults
  }
}

/**
 * Copy a task's models to its worktree's copy of the spec folder. A running task
 * reads that copy, and the worktree gets it only once, when it is created.
 */
export function copyTaskModels(fromSpecDir: string, toSpecDir: string): void {
  if (path.resolve(fromSpecDir) === path.resolve(toSpecDir)) return;
  try {
    const fromPath = path.join(fromSpecDir, METADATA_FILE);
    if (!isRealFile(fromPath)) return;
    const from = JSON.parse(readFileSync(fromPath, 'utf-8')) as ModelMetadata;
    const toPath = path.join(toSpecDir, METADATA_FILE);
    const stat = lstatSync(toPath, { throwIfNoEntry: false });
    if (!stat) return;
    const to = (stat.isFile() ? JSON.parse(readFileSync(toPath, 'utf-8')) : {}) as ModelMetadata;
    for (const field of MODEL_FIELDS) {
      if (from[field] === undefined) delete to[field];
      else to[field] = from[field] as never;
    }
    writeFileReplacingSync(toPath, `${JSON.stringify(to, null, 2)}\n`, 'utf-8');
  } catch {
    // No copy yet, or unreadable: the worktree gets the folder when it is created
  }
}
