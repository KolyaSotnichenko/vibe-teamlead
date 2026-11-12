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

/** A blocker the app already knows (the saved scan's, or one with an open task): what the next scan matches against. */
export interface KnownBlocker {
  key: string;
  kind: BlockerKind;
  /** Missing for a ledger key whose scan result is gone: the key's words stand in */
  subject?: string;
  title: string;
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'on', 'of', 'in', 'for', 'is', 'are', 'be', 'and', 'or', 'by', 'with', 'at', 'from', 'it', 'its']);

/** Lower-case words without filler, a plural `s` dropped ("migrations" = "migration"). */
function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || STOP_WORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return out;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size > 0 && a.size === b.size && [...a].every((w) => b.has(w));

/** Shared words over all words (Jaccard) */
function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/**
 * Half the words of subject and title together shared: the same problem reworded ("database
 * migrations" / "api migrations" with the same title share 5 of 7). Two problems sharing one word
 * ("api base url" and "api migrations") stay far below.
 */
export const SAME_BLOCKER = 0.5;

const subjectWords = (known: KnownBlocker): Set<string> =>
  words(known.subject ?? known.key.slice(known.key.startsWith(`${known.kind}-`) ? known.kind.length + 1 : 0));

function similarity(blocker: { kind: BlockerKind; subject: string; title: string }, known: KnownBlocker): number {
  if (blocker.kind !== known.kind) return 0;
  const subject = words(blocker.subject);
  const knownSubject = subjectWords(known);
  if (sameSet(subject, knownSubject) || blockerKey(blocker.kind, blocker.subject) === known.key) return 1;
  return overlap(new Set([...subject, ...words(blocker.title)]), new Set([...knownSubject, ...words(known.title)]));
}

/** Whether a blocker of a new scan is a known one under other words (same kind, same subject, or SAME_BLOCKER of the words). Pure. */
export function sameBlocker(blocker: { kind: BlockerKind; subject: string; title: string }, known: KnownBlocker): boolean {
  return similarity(blocker, known) >= SAME_BLOCKER;
}

/** The known blocker this one is, the closest when several are; keys in `taken` are already another blocker's. Pure. */
export function matchKnownBlocker(
  blocker: { kind: BlockerKind; subject: string; title: string },
  known: KnownBlocker[],
  taken: Set<string>,
): KnownBlocker | undefined {
  let best: KnownBlocker | undefined;
  let bestScore = SAME_BLOCKER;
  for (const candidate of known) {
    if (taken.has(candidate.key)) continue;
    const score = similarity(blocker, candidate);
    if (score >= bestScore && (!best || score > bestScore)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
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
