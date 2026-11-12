/** The one readiness orchestrator of the app, shared by the IPC handlers and the after-merge hook. */
import type { Readiness } from './readiness';

let instance: Readiness | undefined;

export function setReadiness(readiness: Readiness): void {
  instance = readiness;
}

export function getReadiness(): Readiness | undefined {
  return instance;
}
