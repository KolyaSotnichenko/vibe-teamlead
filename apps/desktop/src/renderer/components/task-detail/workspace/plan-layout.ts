/**
 * Deterministic layout for the plan dependency graph.
 *
 * Phases are stacked as rows (top → bottom in plan order), so the graph grows
 * downwards and reads like the plan file. Inside a phase, a subtask's column is
 * its depth along dependencies on subtasks of the same phase; subtasks at the
 * same depth stack vertically in plan order. No layout engine needed and the
 * result is stable across re-renders.
 */

import type { WorkspacePlan, WorkspacePlanSubtask } from '../../../../shared/types';

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 96;
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
  phases: LaidOutPhase[];
  width: number;
  height: number;
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

export function layoutPlan(plan: WorkspacePlan): PlanLayout {
  const phases: LaidOutPhase[] = [];
  let cursorY = 0;
  let maxWidth = 0;

  plan.phases.forEach((phase, index) => {
    const depths = localDepths(phase.subtasks);
    const rowsPerDepth = new Map<number, number>();
    const subtasks: LaidOutSubtask[] = phase.subtasks.map((subtask) => {
      const d = depths.get(subtask.id) ?? 0;
      const row = rowsPerDepth.get(d) ?? 0;
      rowsPerDepth.set(d, row + 1);
      return {
        subtask,
        x: PHASE_PADDING + d * (NODE_WIDTH + NODE_GAP_X),
        y: PHASE_HEADER + PHASE_PADDING_Y + row * (NODE_HEIGHT + NODE_GAP_Y),
      };
    });

    const columns = Math.max(1, ...Array.from(rowsPerDepth.keys(), (d) => d + 1));
    const rows = Math.max(1, ...rowsPerDepth.values());
    const width = PHASE_PADDING * 2 + columns * NODE_WIDTH + (columns - 1) * NODE_GAP_X;
    const height = PHASE_HEADER + PHASE_PADDING_Y * 2 + rows * NODE_HEIGHT + (rows - 1) * NODE_GAP_Y;

    phases.push({ id: phase.id, name: phase.name, index, x: 0, y: cursorY, width, height, subtasks });
    cursorY += height + PHASE_GAP;
    maxWidth = Math.max(maxWidth, width);
  });

  // Same width for every phase row so the stack reads as one datasheet
  for (const phase of phases) phase.width = maxWidth;

  return { phases, width: maxWidth, height: Math.max(0, cursorY - PHASE_GAP) };
}
