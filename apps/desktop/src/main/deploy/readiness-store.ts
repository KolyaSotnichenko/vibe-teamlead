/**
 * The last readiness scan of a project, kept at `<project>/.vibe-teamlead/deploy/readiness.json`
 * so the Environment tab shows it without scanning again.
 */

import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { BlockerKind, ReadinessResult } from '../../shared/types/deploy';
import { writeFileReplacingSync } from '../ai/safe-write';

const KEY_CHARS = 80;

const folder = (projectPath: string) => path.join(projectPath, '.vibe-teamlead', 'deploy');
const file = (projectPath: string) => path.join(folder(projectPath), 'readiness.json');

/** The same blocker found again keeps its key even when the model words it differently. Pure. */
export function blockerKey(kind: BlockerKind, subject: string): string {
  return `${kind}:${subject}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, KEY_CHARS);
}

const isArray = (value: unknown): boolean => Array.isArray(value);

/** The stored scan; null when missing, malformed or a symlink. */
export function readReadiness(projectPath: string): ReadinessResult | null {
  try {
    const target = file(projectPath);
    if (!lstatSync(target).isFile()) return null;
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as Partial<ReadinessResult> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.scannedAt !== 'string') return null;
    if (!isArray(parsed.blockers) || !isArray(parsed.services) || !isArray(parsed.owner)) return null;
    if (!parsed.workflow || typeof parsed.workflow !== 'object') return null;
    return parsed as ReadinessResult;
  } catch {
    return null;
  }
}

export function writeReadiness(projectPath: string, result: ReadinessResult): void {
  mkdirSync(folder(projectPath), { recursive: true });
  writeFileReplacingSync(file(projectPath), `${JSON.stringify(result, null, 2)}\n`);
}
