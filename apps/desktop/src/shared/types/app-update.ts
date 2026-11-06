/**
 * Types for Electron app auto-update functionality
 */

export interface AppUpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
}

export interface AppUpdateAvailableEvent {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface AppUpdateDownloadedEvent {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

/** What happens to a downloaded update, without the user having to act */
export type AppUpdateAutoInstallState =
  | { kind: 'countdown'; seconds: number }
  | { kind: 'waiting'; tasks: number }
  | { kind: 'idle' };

export interface AppUpdateErrorEvent {
  message: string;
}
