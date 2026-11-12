/** The one readiness orchestrator of the app, shared by the IPC handlers and the after-merge hook. */
import type { MainRunDeps } from './main-runs';
import type { Readiness } from './readiness';

let instance: Readiness | undefined;

export function setReadiness(readiness: Readiness): void {
  instance = readiness;
}

export function getReadiness(): Readiness | undefined {
  return instance;
}

let mainRunDeps: MainRunDeps | undefined;

/** The deps of the main-run handler and watcher (Actions client, repo, task creation), set once by the deploy handlers. */
export function setMainRunDeps(deps: MainRunDeps): void {
  mainRunDeps = deps;
}

export function getMainRunDeps(): MainRunDeps | undefined {
  return mainRunDeps;
}
