/**
 * Push the project's main branch to its GitHub repository after a merge.
 *
 * Per project, one push runs at a time; merges that finish while it runs share ONE
 * follow-up push (which carries the newest main), so the last merge is never lost
 * and a burst of merges is not a burst of pushes. Nothing here throws: the result
 * goes to the emitter and back to the caller.
 */
import type { Project } from '../../shared/types';

export interface DeployPushResult {
  projectId: string;
  ok: boolean;
  error?: { kind: string; message: string };
  at: string;
}

export interface PushAfterMergeDeps {
  /** `pushWithAppToken` in production */
  push: (projectPath: string, url: string, refspec: string) => Promise<void>;
  emit: (result: DeployPushResult) => void;
  now?: () => string;
}

export interface PushAfterMergeOutcome {
  pushed: boolean;
  error?: string;
}

interface Queued {
  branch: string;
  promise: Promise<PushAfterMergeOutcome>;
  resolve: (o: PushAfterMergeOutcome) => void;
}

interface ProjectState {
  running: boolean;
  queued?: Queued;
}

const states = new Map<string, ProjectState>();

async function pushOnce(
  projectId: string,
  projectPath: string,
  url: string,
  branch: string,
  deps: PushAfterMergeDeps,
): Promise<PushAfterMergeOutcome> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  let result: DeployPushResult;
  let outcome: PushAfterMergeOutcome;
  try {
    await deps.push(projectPath, url, branch);
    result = { projectId, ok: true, at };
    outcome = { pushed: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The push failed';
    const kind = typeof (e as { kind?: unknown })?.kind === 'string' ? (e as { kind: string }).kind : 'unknown';
    result = { projectId, ok: false, error: { kind, message }, at };
    outcome = { pushed: false, error: message };
  }
  try {
    deps.emit(result);
  } catch {
    // informational
  }
  return outcome;
}

/** Fire and forget from the merge handler; never rejects. */
export async function pushMainAfterMerge(
  project: Pick<Project, 'id' | 'path' | 'settings'>,
  deps: PushAfterMergeDeps,
  mergedInto?: string,
): Promise<PushAfterMergeOutcome> {
  const deploy = project.settings?.deploy;
  if (!deploy?.enabled || !deploy.repo) return { pushed: false };
  const branch = project.settings.mainBranch || mergedInto || 'main';
  const url = `https://github.com/${deploy.repo.owner}/${deploy.repo.repo}.git`;

  let state = states.get(project.id);
  if (!state) {
    state = { running: false };
    states.set(project.id, state);
  }
  if (state.running) {
    if (state.queued) {
      state.queued.branch = branch;
      return state.queued.promise;
    }
    let resolve!: (o: PushAfterMergeOutcome) => void;
    const promise = new Promise<PushAfterMergeOutcome>((r) => { resolve = r; });
    state.queued = { branch, promise, resolve };
    return promise;
  }

  state.running = true;
  try {
    const first = await pushOnce(project.id, project.path, url, branch, deps);
    // Drain: merges that arrived meanwhile get one more push
    while (state.queued) {
      const q = state.queued;
      state.queued = undefined;
      q.resolve(await pushOnce(project.id, project.path, url, q.branch, deps));
    }
    return first;
  } finally {
    state.running = false;
    if (!state.queued) states.delete(project.id);
  }
}
