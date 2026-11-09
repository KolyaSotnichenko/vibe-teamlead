/**
 * The in-app Preview: the project's app from main, run while its view is open.
 */

import type { IPCResult } from './common';
import type { PreviewService } from './project';

export type PreviewStage = 'worktree' | 'install' | 'libraries' | 'database' | 'migrations' | 'seed' | 'services' | 'ready' | 'failed' | 'stopped';

export interface PreviewStatus {
  projectId: string;
  /** Set for a task's preview (its worktree), absent for the project's (main) */
  taskId?: string;
  stage: PreviewStage;
  url?: string;
  /** Where the view may navigate */
  origins: string[];
  message?: string;
  logTail?: string;
  database?: 'none' | 'started' | 'unavailable';
  databaseReason?: string;
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PreviewNavigation = { action: 'back' | 'forward' | 'reload' } | { url: string };

/** What the page's notes overlay reports, after the main process checked it */
export type PreviewOverlayEvent =
  | { type: 'picked'; route: string; width: number; pick: import('../../preview-overlay/protocol').Pick; image?: string }
  | { type: 'detached'; ns: number[] }
  | { type: 'escape' }
  | { type: 'route'; route: string };

/** A note the owner left on an element or a region of the previewed app */
export interface PreviewNote {
  id: string;
  /** Its pin's number */
  n: number;
  route: string;
  /** The view's width when it was left, in pixels */
  width: number;
  text: string;
  pick: import('../../preview-overlay/protocol').Pick;
  /** PNG data URL of the element or region */
  image?: string;
  createdAt: string;
}

/** One problem the UX review found on the running app */
export interface UxFinding {
  /** The route, e.g. `/login` */
  page: string;
  /** The width it was seen at, in pixels */
  width: number;
  /** blocks: a person can't use the page as meant; note: polish */
  severity: 'blocks' | 'note';
  problem: string;
  expected: string;
  /** The source file to change, when the reviewer found it */
  file?: string;
}

export interface UxReviewResult {
  findings: UxFinding[];
  summary: string;
  /** The pages it opened */
  pages: string[];
  at: string;
}

export interface PreviewAPI {
  /** `taskId`: that task's worktree instead of main */
  start: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewStatus>>;
  stop: () => Promise<IPCResult>;
  onStatus: (callback: (status: PreviewStatus) => void) => () => void;
  setBounds: (bounds: PreviewBounds | null) => Promise<IPCResult>;
  navigate: (navigation: PreviewNavigation) => Promise<IPCResult>;
  proposeServices: (projectId: string) => Promise<IPCResult<PreviewService[]>>;
  resetData: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewStatus>>;
  /** Reviews the running preview's pages as a person would use them (one agent session) */
  uxReview: (projectId: string) => Promise<IPCResult<UxReviewResult>>;
  cancelUxReview: () => Promise<IPCResult>;
  /** The last review of this project, if any */
  lastUxReview: (projectId: string) => Promise<IPCResult<UxReviewResult | null>>;
  /** Notes mode: the page outlines elements and takes clicks and drags as notes */
  setNotesMode: (on: boolean) => Promise<IPCResult>;
  /** The pins of the page's current route */
  setPins: (pins: Array<{ n: number; selector: string }>) => Promise<IPCResult>;
  focusPin: (n: number) => Promise<IPCResult>;
  onOverlayEvent: (callback: (event: PreviewOverlayEvent) => void) => () => void;
  loadNotes: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewNote[]>>;
  /** Replaces the draft; returns what was kept */
  saveNotes: (projectId: string, notes: PreviewNote[], taskId?: string) => Promise<IPCResult<PreviewNote[]>>;
}
