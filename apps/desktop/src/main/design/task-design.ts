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
    if (typeof c.selector === 'string' && c.selector) comment.selector = c.selector.slice(0, 300);
    if (typeof c.x === 'number' && Number.isFinite(c.x)) comment.x = Math.round(c.x);
    if (typeof c.y === 'number' && Number.isFinite(c.y)) comment.y = Math.round(c.y);
    comments.push(comment);
    if (comments.length >= MAX_COMMENTS) break;
  }
  return comments.length ? { ...state, comments } : null;
}

export interface DesignCompare {
  screens: Array<{ file: string; width: number; built?: string; differences: Array<{ severity: 'blocking' | 'minor'; text: string }> }>;
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
        differences,
      });
    }
    return { screens };
  } catch {
    return null;
  }
}
