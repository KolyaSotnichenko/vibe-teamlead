/**
 * What the owner decided about subtasks a coder gave up on, kept in the app's data and not
 * in the task's folder. Agents can write the plan, so a flag or an instruction there could
 * be theirs; the coder's next session and the QA reviewer take the owner's word only from
 * here. No Electron imports: the main process passes the file to the worker.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileReplacingSync } from '../safe-write';
import { OWNER_INSTRUCTION_MAX, type DecidedSubtask, type FailedSubtaskAction } from './failed-subtasks';

export interface OwnerDecisions {
  /** Subtasks the owner went on without: id → fingerprint of the subtask they saw */
  skipped: Record<string, string>;
  /** Subtasks the owner sent back, with what they said and the fingerprint of the subtask they saw */
  instructions: Record<string, { text: string; fingerprint: string }>;
}

interface StoredDecision {
  skipped?: boolean;
  instruction?: string;
  fingerprint?: string;
  at?: string;
}

/** The file for a task, named after its spec directory in the main project. Pure. */
export function ownerDecisionsPath(userDataDir: string, mainSpecDir: string): string {
  const key = createHash('sha256').update(mainSpecDir).digest('hex').slice(0, 24);
  return join(userDataDir, 'owner-decisions', `${key}.json`);
}

function readStored(file: string): Record<string, StoredDecision> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { subtasks?: unknown };
    return parsed && typeof parsed.subtasks === 'object' && parsed.subtasks ? (parsed.subtasks as Record<string, StoredDecision>) : {};
  } catch {
    return {};
  }
}

export function readOwnerDecisions(file: string | undefined): OwnerDecisions {
  const decisions: OwnerDecisions = { skipped: {}, instructions: {} };
  if (!file) return decisions;
  for (const [id, entry] of Object.entries(readStored(file))) {
    // Without the fingerprint a decision can't be matched to what the owner saw
    if (!entry || typeof entry !== 'object' || typeof entry.fingerprint !== 'string' || !entry.fingerprint) continue;
    if (entry.skipped === true) decisions.skipped[id] = entry.fingerprint;
    if (typeof entry.instruction === 'string' && entry.instruction) {
      decisions.instructions[id] = { text: entry.instruction.slice(0, OWNER_INSTRUCTION_MAX), fingerprint: entry.fingerprint };
    }
  }
  return decisions;
}

/** Replaces what was decided earlier about these subtasks. */
export function recordOwnerDecision(file: string, subtasks: DecidedSubtask[], decision: FailedSubtaskAction): void {
  const stored = readStored(file);
  const at = new Date().toISOString();
  const instruction = decision.action === 'retry' ? (decision.instruction ?? '').trim().slice(0, OWNER_INSTRUCTION_MAX) : '';
  for (const { id, fingerprint } of subtasks) {
    if (decision.action === 'skip') stored[id] = { skipped: true, fingerprint, at };
    else if (instruction) stored[id] = { instruction, fingerprint, at };
    else delete stored[id];
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileReplacingSync(file, JSON.stringify({ subtasks: stored }, null, 2), 'utf-8');
}
