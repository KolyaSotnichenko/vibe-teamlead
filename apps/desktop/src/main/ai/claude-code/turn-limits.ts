/**
 * Sessions that stopped at their turn limit, for the task window: without this
 * they show only as one line in a long log. A new run starts clean. Written to
 * the spec directory, which agents can reach, so reads check every field. No
 * Electron imports.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileReplacingSync } from '../safe-write';
import type { TurnLimitHit } from '../../../shared/types/task-workspace';

export const TURN_LIMITS_FILE = 'turn_limits.json';

/** Well-formed records only. Pure. */
export function parseTurnLimits(value: unknown): TurnLimitHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TurnLimitHit[] => {
    const hit = item as Partial<TurnLimitHit> | null;
    if (typeof hit?.agentType !== 'string' || typeof hit.limit !== 'number' || typeof hit.count !== 'number') return [];
    return [{
      agentType: hit.agentType,
      ...(typeof hit.subtaskId === 'string' ? { subtaskId: hit.subtaskId } : {}),
      limit: hit.limit,
      count: hit.count,
    }];
  });
}

function read(file: string): TurnLimitHit[] {
  try {
    return parseTurnLimits(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return [];
  }
}

/** Never throws: a session's outcome doesn't depend on this note. */
export function recordTurnLimit(specDir: string, hit: { agentType: string; subtaskId?: string; limit: number }): void {
  const file = join(specDir, TURN_LIMITS_FILE);
  const hits = read(file);
  const same = hits.find((h) => h.agentType === hit.agentType && h.subtaskId === hit.subtaskId);
  if (same) {
    same.count++;
    same.limit = hit.limit;
  } else {
    hits.push({ agentType: hit.agentType, ...(hit.subtaskId ? { subtaskId: hit.subtaskId } : {}), limit: hit.limit, count: 1 });
  }
  try {
    writeFileReplacingSync(file, JSON.stringify(hits, null, 2));
  } catch {
    // informational
  }
}

export function clearTurnLimits(specDir: string): void {
  try {
    rmSync(join(specDir, TURN_LIMITS_FILE), { force: true });
  } catch {
    // informational
  }
}
