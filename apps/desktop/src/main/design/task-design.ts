/**
 * The Design tab's side of design before code (ai/design/design-step.ts): what the owner's
 * approval and comments do to the design state, and QA's comparison of the built pages with the
 * design (design_compare.json, written by the QA reviewer). Pure.
 */

import type { DesignComment, DesignState } from '../ai/design/design-step';

const MAX_COMMENTS = 40;
const MAX_TEXT = 2000;

/** The state after the owner approves `stage`, or null when the task doesn't wait at that stage. */
export function approvedState(state: DesignState | undefined, stage: 'wireframes' | 'design', now = new Date()): DesignState | null {
  if (!state || state.stage !== stage || state.approved?.[stage]) return null;
  const { comments: _dropped, ...rest } = state;
  return { ...rest, approved: { ...(state.approved ?? {}), [stage]: now.toISOString() } };
}

/** The state with the owner's comments for the designer's next round, or null when there are none. */
export function commentedState(state: DesignState | undefined, raw: unknown, frames: string[]): DesignState | null {
  if (!state || state.stage === 'skipped' || !Array.isArray(raw)) return null;
  const comments: DesignComment[] = [];
  for (const item of raw.slice(0, MAX_COMMENTS * 2)) {
    const c = (item ?? {}) as Record<string, unknown>;
    const text = typeof c.text === 'string' ? c.text.trim().slice(0, MAX_TEXT) : '';
    const frame = typeof c.frame === 'string' ? c.frame : '';
    if (!text || (frame && !frames.includes(frame))) continue;
    const comment: DesignComment = { n: comments.length + 1, frame, text };
    if (typeof c.width === 'number' && Number.isFinite(c.width)) comment.width = Math.round(c.width);
    if (typeof c.selector === 'string' && c.selector) comment.selector = c.selector.slice(0, 300);
    if (typeof c.x === 'number' && Number.isFinite(c.x)) comment.x = Math.round(c.x);
    if (typeof c.y === 'number' && Number.isFinite(c.y)) comment.y = Math.round(c.y);
    comments.push(comment);
    if (comments.length >= MAX_COMMENTS) break;
  }
  return comments.length ? { ...state, comments } : null;
}

/** The owner chose to build without the design the designer could not make. Pure. */
export function ownerSkippedState(state: DesignState | undefined, reason: string, now = new Date()): DesignState {
  const { comments: _dropped, ...rest } = state ?? { round: 0 };
  return { ...rest, stage: 'skipped', skipped: { by: 'owner', reason: reason.slice(0, 500), at: now.toISOString() } } as DesignState;
}

const DESIGNER_STOPPED = /^Design: the designer stopped \((.*)\); building from the spec without a design/;

/**
 * Why a skipped design was skipped, when it was not for want of UI: the owner's choice, or (tasks
 * from before the owner was asked) the designer stopping, read from the task's log. Pure.
 */
export function designSkipNote(state: DesignState | undefined, taskLogs: string | undefined): { by: 'owner' | 'designer'; reason: string } | null {
  if (state?.stage !== 'skipped') return null;
  if (state.skipped?.by === 'owner') return { by: 'owner', reason: state.skipped.reason ?? '' };
  try {
    const phases = (JSON.parse(taskLogs ?? '') as { phases?: Record<string, { entries?: Array<{ content?: unknown }> }> }).phases ?? {};
    for (const phase of Object.values(phases)) {
      for (const entry of phase?.entries ?? []) {
        const match = typeof entry?.content === 'string' ? DESIGNER_STOPPED.exec(entry.content) : null;
        if (match) return { by: 'designer', reason: match[1].slice(0, 500) };
      }
    }
  } catch {
    // no log
  }
  return null;
}

export interface DesignCompare {
  /** `notShown`: why QA could not open this frame in the running app (the task then waits for the owner) */
  screens: Array<{ file: string; width: number; built?: string; notShown?: string; differences: Array<{ severity: 'blocking' | 'minor'; text: string }> }>;
  /** The project's other screens that changed since the last merge, with QA's verdict (the screen check) */
  regressions?: Array<{ id: string; width: number; verdict: 'expected' | 'regression'; why: string }>;
}

/** QA's comparison of the built pages with the design, or null. */
export function parseCompare(raw: string): DesignCompare | null {
  try {
    const parsed = JSON.parse(raw) as { screens?: unknown[] };
    if (!Array.isArray(parsed?.screens)) return null;
    const screens: DesignCompare['screens'] = [];
    for (const item of parsed.screens.slice(0, 60)) {
      const s = (item ?? {}) as Record<string, unknown>;
      if (typeof s.file !== 'string' || !s.file) continue;
      const differences = (Array.isArray(s.differences) ? s.differences : [])
        .map((d) => (d ?? {}) as Record<string, unknown>)
        .filter((d) => typeof d.text === 'string' && d.text.trim())
        .slice(0, 30)
        .map((d) => ({ severity: d.severity === 'blocking' ? ('blocking' as const) : ('minor' as const), text: String(d.text).slice(0, 600) }));
      screens.push({
        file: s.file,
        width: typeof s.width === 'number' && Number.isFinite(s.width) ? s.width : 0,
        ...(typeof s.built === 'string' && s.built ? { built: s.built } : {}),
        ...(typeof s.notShown === 'string' && s.notShown.trim() ? { notShown: s.notShown.replace(/\s+/g, ' ').trim().slice(0, 500) } : {}),
        differences,
      });
    }
    const regressions: NonNullable<DesignCompare['regressions']> = [];
    for (const item of (Array.isArray((parsed as { regressions?: unknown }).regressions) ? (parsed as { regressions: unknown[] }).regressions : []).slice(0, 60)) {
      const r = (item ?? {}) as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id || (r.verdict !== 'expected' && r.verdict !== 'regression')) continue;
      regressions.push({
        id: r.id.slice(0, 200),
        width: typeof r.width === 'number' && Number.isFinite(r.width) ? r.width : 0,
        verdict: r.verdict,
        why: typeof r.why === 'string' ? r.why.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
      });
    }
    return regressions.length ? { screens, regressions } : { screens };
  } catch {
    return null;
  }
}
