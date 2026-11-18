/**
 * What the cloud-infrastructure word match reads for an architect session: the
 * task's spec, its requirements and its description. Small files, read once per
 * architect session. No Electron: the worker uses it.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 512 * 1024;

function readSmall(file: string): string {
  try {
    if (statSync(file).size > MAX_BYTES) return '';
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

export function architectTaskText(specDir: string, description = ''): string {
  return [description, readSmall(join(specDir, 'spec.md')), readSmall(join(specDir, 'requirements.json'))].filter(Boolean).join('\n');
}
