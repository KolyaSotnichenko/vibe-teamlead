/**
 * When and how the project's design system was last written, and which references it took
 * in, so the Design system tab can say when references came after it. Kept in the app's
 * folder of the project, next to the references.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { DesignSystemMeta } from '../../../shared/types';
import { writeFileReplacingSync } from '../safe-write';

const metaFile = (projectPath: string) => path.join(projectPath, '.vibe-teamlead', 'design', 'system-meta.json');

export function readSystemMeta(projectPath: string): DesignSystemMeta | undefined {
  try {
    const raw = JSON.parse(readFileSync(metaFile(projectPath), 'utf-8')) as Partial<DesignSystemMeta>;
    if (typeof raw.writtenAt !== 'string' || !['extract', 'direction', 'edited', 'package'].includes(String(raw.how))) return undefined;
    return {
      writtenAt: raw.writtenAt,
      how: raw.how as DesignSystemMeta['how'],
      ...(typeof raw.direction === 'string' ? { direction: raw.direction } : {}),
      ...(typeof raw.packageName === 'string' ? { packageName: raw.packageName } : {}),
      referenceIds: Array.isArray(raw.referenceIds) ? raw.referenceIds.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return undefined;
  }
}

/** After the system was written. An edit keeps the references the system already took in. */
export function recordSystemMeta(
  projectPath: string,
  written: { how: DesignSystemMeta['how']; direction?: string; packageName?: string; referenceIds?: string[] },
  now = new Date().toISOString(),
): void {
  const referenceIds = written.referenceIds ?? readSystemMeta(projectPath)?.referenceIds ?? [];
  const meta: DesignSystemMeta = { writtenAt: now, how: written.how, ...(written.direction ? { direction: written.direction } : {}), ...(written.packageName ? { packageName: written.packageName } : {}), referenceIds };
  mkdirSync(path.dirname(metaFile(projectPath)), { recursive: true });
  writeFileReplacingSync(metaFile(projectPath), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}
