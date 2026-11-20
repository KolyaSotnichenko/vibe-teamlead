/**
 * What the status bar's left side shows: live state from data the app already has (the board's
 * tasks, the queue pause, pending agent questions, the last CI run on main). Only what needs the
 * user is an alert (a question waiting, a failed CI run on main); everything else stays quiet.
 *
 * The counts live here and nowhere else in the window's frame: the sidebar used to repeat them.
 * The question is the other way round: the open sidebar shows it, so the bar shows it only when
 * the sidebar is collapsed to a bare number.
 */

export type CiState = 'passing' | 'failing' | 'other';

export interface StatusInput {
  hasProject: boolean;
  /** Tasks an agent is working on (coding or QA) */
  working: number;
  queued: number;
  /** Tasks waiting for the user's review */
  review: number;
  /** The queue starts no new task */
  paused: boolean;
  /** Agent questions waiting for the user */
  waiting: number;
  /** The open sidebar shows the waiting question in words, so the bar leaves it out */
  sidebarShowsWaiting: boolean;
  /** The GitHub conclusion of the last CI run on main; null when CI is not set up or no run is recorded */
  ciConclusion: string | null;
}

/** Where a click on an item goes */
export type StatusTarget = 'question' | 'kanban' | 'ci';

export type StatusItem =
  | { key: 'waiting' | 'running' | 'queued' | 'review'; count: number; alert: boolean; target: StatusTarget }
  | { key: 'paused'; alert: boolean; target: StatusTarget }
  | { key: 'ci'; ci: CiState; alert: boolean; target: StatusTarget };

const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);

export function ciState(conclusion: string): CiState {
  if (conclusion === 'success') return 'passing';
  return FAILING.has(conclusion) ? 'failing' : 'other';
}

export function statusItems(input: StatusInput): StatusItem[] {
  const items: StatusItem[] = [];
  // Questions are not tied to an open project: one waiting shows even with none
  if (input.waiting > 0 && !input.sidebarShowsWaiting) items.push({ key: 'waiting', count: input.waiting, alert: true, target: 'question' });
  if (!input.hasProject) return items;
  items.push({ key: 'running', count: input.working, alert: false, target: 'kanban' });
  items.push({ key: 'queued', count: input.queued, alert: false, target: 'kanban' });
  items.push({ key: 'review', count: input.review, alert: false, target: 'kanban' });
  if (input.paused) items.push({ key: 'paused', alert: false, target: 'kanban' });
  if (input.ciConclusion) {
    const ci = ciState(input.ciConclusion);
    items.push({ key: 'ci', ci, alert: ci === 'failing', target: 'ci' });
  }
  return items;
}
