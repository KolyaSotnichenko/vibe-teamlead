/**
 * The last readiness scan of a project, kept at `<project>/.vibe-teamlead/deploy/readiness.json`
 * so the Environment tab shows it without scanning again.
 */

import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { BlockerKind, ReadinessBlocker, ReadinessOwnerItem, ReadinessResult } from '../../shared/types/deploy';
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

/** Filler, negations and the words every blocker of a kind shares: they say nothing about which thing it is */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'on', 'of', 'in', 'for', 'is', 'are', 'be', 'and', 'or', 'by', 'with', 'at', 'from', 'it', 'its',
  'no', 'not', 'never', 'does', 'do', 'has', 'have', 'ci', 'code', 'workflow',
]);

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
 * The word fallback (the model's `sameAs` comes first): half the words of subject and title
 * together shared, e.g. "database migrations" / "api migrations" with the same title.
 */
export const SAME_BLOCKER = 0.5;

/** A known blocker's subject: its own, else its key without the kind, in words ("code-transactional-email" → "transactional email") */
export function knownSubject(known: KnownBlocker): string {
  if (known.subject) return known.subject;
  const prefix = `${known.kind}-`;
  return (known.key.startsWith(prefix) ? known.key.slice(prefix.length) : known.key).replace(/[-_:]+/g, ' ').trim();
}

interface NewBlocker {
  kind: BlockerKind;
  subject: string;
  title: string;
}

/** The model named the known blocker itself: its subject, its key, or the kind and its key */
function namesKnown(blocker: NewBlocker, known: KnownBlocker): boolean {
  if (blocker.kind !== known.kind) return false;
  const key = blockerKey(blocker.kind, blocker.subject);
  return key === known.key || key === blockerKey(known.kind, `${known.kind}-${known.key}`) || sameSet(words(blocker.subject), words(knownSubject(known)));
}

/** Words one subject has that the other blocker never mentions: the thing that tells them apart (postgres / redis) */
const differs = (subject: Set<string>, other: Set<string>): boolean => [...subject].some((w) => !other.has(w));

/** Word score of a new blocker against a known one, 0 when the fallback must not merge them. Pure. */
function similarity(blocker: NewBlocker, known: KnownBlocker): number {
  if (blocker.kind !== known.kind) return 0;
  if (namesKnown(blocker, known)) return 1;
  const subject = words(blocker.subject);
  const other = words(knownSubject(known));
  // At least one meaningful word in both subjects
  if (![...subject].some((w) => other.has(w))) return 0;
  const title = words(blocker.title);
  const otherTitle = words(known.title);
  if (sameSet(title, otherTitle)) return 0.99;
  const all = new Set([...subject, ...title]);
  const otherAll = new Set([...other, ...otherTitle]);
  // Each names something the other never mentions: two things, not one reworded
  if (differs(subject, otherAll) && differs(other, all)) return 0;
  return overlap(all, otherAll);
}

/** Whether a blocker of a new scan is a known one under other words (the fallback when the model gives no sameAs). Pure. */
export function sameBlocker(blocker: NewBlocker, known: KnownBlocker): boolean {
  return similarity(blocker, known) >= SAME_BLOCKER;
}

/**
 * The known key each new blocker keeps (undefined: a new blocker). In this order: the model's
 * `sameAs` when it is a known key of the same kind; a subject naming a known blocker; then the
 * word fallback, best score first over all pairs, so the order of the list doesn't matter. Each
 * known key goes to one blocker. Pure.
 */
export function assignKnownKeys(blockers: Array<NewBlocker & { sameAs?: string }>, known: KnownBlocker[]): Array<string | undefined> {
  const out: Array<string | undefined> = blockers.map(() => undefined);
  const taken = new Set<string>();
  blockers.forEach((b, i) => {
    const hit = b.sameAs ? known.find((k) => k.key === b.sameAs && k.kind === b.kind) : undefined;
    if (hit && !taken.has(hit.key)) {
      out[i] = hit.key;
      taken.add(hit.key);
    }
  });
  const pairs: Array<{ i: number; key: string; score: number }> = [];
  blockers.forEach((b, i) => {
    if (out[i]) return;
    for (const k of known) {
      if (taken.has(k.key)) continue;
      const score = similarity(b, k);
      if (score >= SAME_BLOCKER) pairs.push({ i, key: k.key, score });
    }
  });
  // Best first; ties go to the earlier blocker
  pairs.sort((a, b) => b.score - a.score || a.i - b.i);
  for (const p of pairs) {
    if (out[p.i] || taken.has(p.key)) continue;
    out[p.i] = p.key;
    taken.add(p.key);
  }
  return out;
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A saved blocker of a kind CI readiness has; the old Deploy's `unsupported` ones are dropped. */
const isBlocker = (b: unknown): b is ReadinessBlocker => isObject(b) && (b.kind === 'code' || b.kind === 'workflow');

/** A saved owner item (a string message, a string name if any); the old Deploy's `variable` kind is a secret now. */
function ownerItem(item: unknown): ReadinessOwnerItem | null {
  if (!isObject(item) || typeof item.message !== 'string') return null;
  if (item.variable !== undefined && typeof item.variable !== 'string') return null;
  const kind = item.kind === 'variable' ? 'secret' : item.kind;
  if (kind !== 'secret' && kind !== 'other') return null;
  return { ...(item as unknown as ReadinessOwnerItem), kind };
}

/**
 * The stored scan; null when missing, malformed or a symlink. A result the old Vercel Deploy saved
 * still reads: its services are dropped, `unsupported` blockers too, `variable` items are secrets.
 */
export function readReadiness(projectPath: string): ReadinessResult | null {
  try {
    const target = file(projectPath);
    if (!lstatSync(target).isFile()) return null;
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown> | null;
    if (!isObject(parsed) || typeof parsed.scannedAt !== 'string') return null;
    if (!isArray(parsed.blockers) || !isArray(parsed.owner)) return null;
    if (!isObject(parsed.workflow)) return null;
    const { services: _services, ...rest } = parsed;
    return {
      ...(rest as unknown as ReadinessResult),
      blockers: parsed.blockers.filter(isBlocker),
      owner: parsed.owner.map(ownerItem).filter((item): item is ReadinessOwnerItem => item !== null),
    };
  } catch {
    return null;
  }
}

export function writeReadiness(projectPath: string, result: ReadinessResult): void {
  mkdirSync(folder(projectPath), { recursive: true });
  writeFileReplacingSync(file(projectPath), `${JSON.stringify(result, null, 2)}\n`);
}
