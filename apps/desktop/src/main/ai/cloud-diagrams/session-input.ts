/**
 * What the cloud-infrastructure word match reads for an architect session: the
 * task's spec, its requirements and its description. Small files, read once per
 * architect session. No Electron: the worker uses it.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CLOUD_DESIGN_MARKER } from './infra-heuristic';

const MAX_BYTES = 512 * 1024;

function readSmall(file: string): string {
  try {
    if (statSync(file).size > MAX_BYTES) return '';
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/** A task made by Context → Architecture's button: always about cloud architecture */
function designTaskMarker(specDir: string): string {
  try {
    return JSON.parse(readSmall(join(specDir, 'task_metadata.json')) || '{}')?.cloudArchitectureDesign === true ? CLOUD_DESIGN_MARKER : '';
  } catch {
    return '';
  }
}

export function architectTaskText(specDir: string, description = ''): string {
  return [description, designTaskMarker(specDir), readSmall(join(specDir, 'spec.md')), readSmall(join(specDir, 'requirements.json'))].filter(Boolean).join('\n');
}
