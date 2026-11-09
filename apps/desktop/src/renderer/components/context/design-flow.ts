/**
 * The Design system tab as three steps: references (optional) → the design system →
 * applying it to the code. Which one is next, and what each says. Pure.
 */

import type { DesignAudit, DesignReference, DesignSystemMeta } from '../../../shared/types';

export type DesignStep = 'references' | 'system' | 'apply';

export interface DesignFlow {
  /** The step to do next, or null when nothing is waiting */
  current: DesignStep | null;
  references: { count: number; fresh: number };
  /** References added after the system was written: it doesn't hold them yet */
  freshIds: string[];
  system: { status: 'none' | 'stale' | 'ok' };
  apply: { status: 'waiting' | 'checking' | 'unavailable' | 'diff' | 'clean'; findings?: number; files?: number; uiFiles?: number };
}

export function designFlow(input: {
  exists: boolean;
  meta?: DesignSystemMeta;
  references: Pick<DesignReference, 'id' | 'addedAt' | 'status'>[];
  /** undefined: still checking; null: can't be checked (the system has no tokens) */
  audit: DesignAudit | null | undefined;
}): DesignFlow {
  const ready = input.references.filter((r) => r.status === 'ready');
  const meta = input.meta;
  // Without a record (a system from before), nothing can be told apart: all count as held
  const freshIds = input.exists && meta ? ready.filter((r) => !meta.referenceIds.includes(r.id) && r.addedAt > meta.writtenAt).map((r) => r.id) : [];
  const system: DesignFlow['system'] = { status: !input.exists ? 'none' : freshIds.length ? 'stale' : 'ok' };
  const apply: DesignFlow['apply'] = !input.exists
    ? { status: 'waiting' }
    : input.audit === undefined
      ? { status: 'checking' }
      : input.audit === null
        ? { status: 'unavailable' }
      : { status: input.audit.findings > 0 ? 'diff' : 'clean', findings: input.audit.findings, files: input.audit.files, uiFiles: input.audit.uiFiles };
  const current: DesignStep | null = system.status !== 'ok' ? 'system' : apply.status === 'diff' ? 'apply' : null;
  return { current, references: { count: ready.length, fresh: freshIds.length }, freshIds, system, apply };
}
