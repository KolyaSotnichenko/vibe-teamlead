/**
 * The in-app Preview: the project's app from main, run while its view is open.
 */

import type { IPCResult } from './common';
import type { PreviewService } from './project';

export type PreviewStage = 'worktree' | 'install' | 'database' | 'migrations' | 'seed' | 'services' | 'ready' | 'failed' | 'stopped';

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

export interface PreviewAPI {
  start: (projectId: string) => Promise<IPCResult<PreviewStatus>>;
  stop: () => Promise<IPCResult>;
  onStatus: (callback: (status: PreviewStatus) => void) => () => void;
  setBounds: (bounds: PreviewBounds | null) => Promise<IPCResult>;
  navigate: (navigation: PreviewNavigation) => Promise<IPCResult>;
  proposeServices: (projectId: string) => Promise<IPCResult<PreviewService[]>>;
  resetData: (projectId: string) => Promise<IPCResult<PreviewStatus>>;
}
