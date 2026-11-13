/**
 * How the main window's page runs. No Electron imports, so it can be tested.
 *
 * Background throttling stays on (Chromium's default). Chromium throttles a window only while
 * it is hidden, minimized or fully covered, never one that merely lost focus. Agent and
 * terminal output reach the page over IPC, which is not throttled, and the task queue is
 * driven by those events, not by timers. With throttling off, a minimized window kept
 * drawing and cost as much as a visible one, and `document.visibilityState` never became
 * `hidden`, so no "only while visible" check in the page ever stopped anything.
 */
import type { WebPreferences } from 'electron';

export function mainWindowWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: true, // Enable spell check for text inputs
  };
}
