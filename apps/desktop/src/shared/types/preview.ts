/**
 * The in-app Preview: the project's app from main, run while its view is open.
 */

import type { IPCResult } from './common';
import type { PreviewService } from './project';

export type PreviewStage = 'worktree' | 'install' | 'libraries' | 'database' | 'migrations' | 'seed' | 'services' | 'ready' | 'failed' | 'stopped';

export interface PreviewStatus {
  projectId: string;
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
  start: (projectId: string) => Promise<IPCResult<PreviewStatus>>;
  stop: () => Promise<IPCResult>;
  onStatus: (callback: (status: PreviewStatus) => void) => () => void;
  setBounds: (bounds: PreviewBounds | null) => Promise<IPCResult>;
  navigate: (navigation: PreviewNavigation) => Promise<IPCResult>;
  proposeServices: (projectId: string) => Promise<IPCResult<PreviewService[]>>;
  resetData: (projectId: string) => Promise<IPCResult<PreviewStatus>>;
  /** Reviews the running preview's pages as a person would use them (one agent session) */
  uxReview: (projectId: string) => Promise<IPCResult<UxReviewResult>>;
  cancelUxReview: () => Promise<IPCResult>;
  /** The last review of this project, if any */
  lastUxReview: (projectId: string) => Promise<IPCResult<UxReviewResult | null>>;
}
