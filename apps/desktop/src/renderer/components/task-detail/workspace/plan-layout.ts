/**
 * Deterministic layout for the plan dependency graph.
 *
 * Two directions:
 * - 'LR': phases side by side, left → right in plan order (wide screens);
 * - 'TB': phases stacked as rows, top → bottom (narrow screens, long plans).
 * Inside a phase, a subtask's column is its depth along dependencies on subtasks
 * of the same phase; subtasks at the same depth stack vertically in plan order.
 * Each node is as tall as its title and AC chips need, so nothing is clipped.
 * No layout engine needed and the result is stable across re-renders.
 */

import type { WorkspacePlan, WorkspacePlanSubtask } from '../../../../shared/types';

export const NODE_WIDTH = 232;
/** Smallest node: id row + one title line */
export const NODE_HEIGHT = 64;
/** Title lines shown before the text is clamped (the full title is on hover and in the side panel) */
export const TITLE_MAX_LINES = 3;
const NODE_PAD_Y = 10;
const ID_ROW = 16;
const ROW_GAP = 6;
const TITLE_LINE = 18;
/** Rough characters per title line at 13px in the node's inner width */
const TITLE_CHARS_PER_LINE = 28;
const CHIP_ROW = 18;
const CHIP_GAP = 4;
/** Inner width available for AC chips */
const CHIP_AREA = NODE_WIDTH - 24;

export type PlanDirection = 'LR' | 'TB';
export const NODE_GAP_X = 48;
export const NODE_GAP_Y = 16;
/** Left/right inset of nodes; also the channel cross-phase edges use to enter a node from the left */
export const PHASE_PADDING = 32;
export const PHASE_PADDING_Y = 16;
export const PHASE_HEADER = 44;
export const PHASE_GAP = 48;

export interface LaidOutSubtask {
  subtask: WorkspacePlanSubtask;
  /** Position relative to its phase group */
  x: number;
  y: number;
  height: number;
}

export interface LaidOutPhase {
  id: string;
  name: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  subtasks: LaidOutSubtask[];
}

export interface PlanLayout {
  direction: PlanDirection;
  phases: LaidOutPhase[];
  width: number;
  height: number;
}

/** Height a subtask node needs for its title (up to TITLE_MAX_LINES) and AC chips. Pure. */
export function nodeHeight(subtask: Pick<WorkspacePlanSubtask, 'title' | 'acIds'>): number {
  const words = (subtask.title || '').split(/\s+/).filter(Boolean);
  let lines = 1;
  let used = 0;
  for (const w of words) {
    const len = Math.min(w.length, TITLE_CHARS_PER_LINE);
    if (used === 0) used = len;
    else if (used + 1 + len <= TITLE_CHARS_PER_LINE) used += 1 + len;
    else {
      lines++;
      used = len;
    }
  }
  lines = Math.min(TITLE_MAX_LINES, lines);
  let h = NODE_PAD_Y * 2 + ID_ROW + ROW_GAP + lines * TITLE_LINE;
  if (subtask.acIds.length) {
    let rows = 1;
    let x = 0;
    for (const ac of subtask.acIds) {
      const w = ac.length * 6.2 + 10; // mono 10px + padding and border
      if (x > 0 && x + CHIP_GAP + w > CHIP_AREA) {
        rows++;
        x = w;
      } else x += (x > 0 ? CHIP_GAP : 0) + w;
    }
    h += ROW_GAP + rows * CHIP_ROW + (rows - 1) * CHIP_GAP;
  }
  return Math.max(NODE_HEIGHT, Math.ceil(h));
}

/** Depth of each subtask along same-phase dependencies (cycles are cut). */
export function localDepths(subtasks: WorkspacePlanSubtask[]): Map<string, number> {
  const inPhase = new Map(subtasks.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const subtask = inPhase.get(id);
    let d = 0;
    for (const dep of subtask?.dependsOn ?? []) {
      if (inPhase.has(dep)) d = Math.max(d, visit(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const s of subtasks) visit(s.id);
  return depth;
}

export function layoutPlan(plan: WorkspacePlan, direction: PlanDirection = 'TB'): PlanLayout {
  const phases: LaidOutPhase[] = [];

  plan.phases.forEach((phase, index) => {
    const depths = localDepths(phase.subtasks);
    const columnY = new Map<number, number>();
    const subtasks: LaidOutSubtask[] = phase.subtasks.map((subtask) => {
      const d = depths.get(subtask.id) ?? 0;
      const y = columnY.get(d) ?? PHASE_HEADER + PHASE_PADDING_Y;
      const height = nodeHeight(subtask);
      columnY.set(d, y + height + NODE_GAP_Y);
      return { subtask, x: PHASE_PADDING + d * (NODE_WIDTH + NODE_GAP_X), y, height };
    });

    const columns = Math.max(1, ...Array.from(columnY.keys(), (d) => d + 1));
    const tallest = Math.max(PHASE_HEADER + PHASE_PADDING_Y + NODE_HEIGHT + NODE_GAP_Y, ...columnY.values());
    const width = PHASE_PADDING * 2 + columns * NODE_WIDTH + (columns - 1) * NODE_GAP_X;
    const height = tallest - NODE_GAP_Y + PHASE_PADDING_Y;
    phases.push({ id: phase.id, name: phase.name, index, x: 0, y: 0, width, height, subtasks });
  });

  if (direction === 'LR') {
    // Side by side; every phase as tall as the tallest so the row reads as one band
    let cursorX = 0;
    const maxHeight = Math.max(0, ...phases.map((p) => p.height));
    for (const phase of phases) {
      phase.x = cursorX;
      phase.height = maxHeight;
      cursorX += phase.width + PHASE_GAP;
    }
    return { direction, phases, width: Math.max(0, cursorX - PHASE_GAP), height: maxHeight };
  }

  // Stacked; same width for every phase row so the stack reads as one datasheet
  let cursorY = 0;
  const maxWidth = Math.max(0, ...phases.map((p) => p.width));
  for (const phase of phases) {
    phase.y = cursorY;
    phase.width = maxWidth;
    cursorY += phase.height + PHASE_GAP;
  }
  return { direction, phases, width: maxWidth, height: Math.max(0, cursorY - PHASE_GAP) };
}

/**
 * The direction that shows the plan larger in a viewport of the given size
 * (the one whose fit-to-view zoom is higher). Pure.
 */
export function bestDirection(plan: WorkspacePlan, viewWidth: number, viewHeight: number): PlanDirection {
  if (plan.phases.length <= 1) return 'TB';
  const fit = (l: PlanLayout) => Math.min(viewWidth / Math.max(1, l.width), viewHeight / Math.max(1, l.height));
  return fit(layoutPlan(plan, 'LR')) > fit(layoutPlan(plan, 'TB')) ? 'LR' : 'TB';
}
