/**
 * Push the project's main branch to its GitHub repository after a merge.
 *
 * Per project, one push runs at a time; merges that finish while it runs share ONE
 * follow-up push (which carries the newest main), so the last merge is never lost
 * and a burst of merges is not a burst of pushes. Nothing here throws: the result
 * goes to the emitter and back to the caller.
 */
import { execFile } from 'node:child_process';
import type { Project } from '../../shared/types';
import type { DeployPushResult } from '../../shared/types/deploy';
import { getToolPath } from '../cli-tool-manager';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { isCiSetUp } from './ci-setup';
import { readGitInfo } from './setup';

export type { DeployPushResult };

export interface PushAfterMergeDeps {
  /** `pushWithAppToken` in production */
  push: (projectPath: string, url: string, refspec: string) => Promise<void>;
  emit: (result: DeployPushResult) => void;
  now?: () => string;
  /** The project's local branch names, read from .git files; readGitInfo in production */
  branches?: (projectPath: string) => Promise<string[]>;
  /** The commit a branch points at (what was pushed); `branchHead` in production. Without it the outcome has no sha. */
  headSha?: (projectPath: string, branch: string) => Promise<string | undefined>;
}

export interface PushAfterMergeOutcome {
  pushed: boolean;
  error?: string;
  /** The commit pushed (only when the pushed branch's head could be read) */
  sha?: string;
}

/** The commit a local branch points at; undefined on any failure. */
export function branchHead(projectPath: string, branch: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      getToolPath('git'),
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      { cwd: projectPath, env: getIsolatedGitEnv() as NodeJS.ProcessEnv, timeout: 10_000, encoding: 'utf-8' },
      (err, stdout) => {
        const sha = String(stdout ?? '').trim();
        resolve(!err && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined);
      },
    );
  });
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
const lastResults = new Map<string, DeployPushResult>();

/** The last push result of a project in this app session (the Deploy view shows it after a reload). */
export function lastPushResult(projectId: string): DeployPushResult | undefined {
  return lastResults.get(projectId);
}

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
    // Read before the push: a merge that lands meanwhile has its own (queued) push
    const sha = deps.headSha ? await deps.headSha(projectPath, branch).catch(() => undefined) : undefined;
    await deps.push(projectPath, url, branch);
    result = { projectId, ok: true, at };
    outcome = sha ? { pushed: true, sha } : { pushed: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The push failed';
    const kind = typeof (e as { kind?: unknown })?.kind === 'string' ? (e as { kind: string }).kind : 'unknown';
    result = { projectId, ok: false, error: { kind, message }, at };
    outcome = { pushed: false, error: message };
  }
  lastResults.set(projectId, result);
  try {
    deps.emit(result);
  } catch {
    // informational
  }
  return outcome;
}

/** The project's main branch: settings.mainBranch, else `main` or `master` among the local branches (read from .git files). Undefined when unknown; never throws. */
export async function resolveMainBranch(
  project: Pick<Project, 'path' | 'settings'>,
  branches?: (projectPath: string) => Promise<string[]>,
): Promise<string | undefined> {
  if (project.settings?.mainBranch) return project.settings.mainBranch;
  let names: string[] = [];
  try {
    names = await (branches ?? (async (p) => (await readGitInfo(p))?.branches ?? []))(project.path);
  } catch {
    // unknown
  }
  return names.includes('main') ? 'main' : names.includes('master') ? 'master' : undefined;
}

/** Fire and forget from the merge handler; never rejects. */
export async function pushMainAfterMerge(
  project: Pick<Project, 'id' | 'path' | 'settings'>,
  deps: PushAfterMergeDeps,
  mergedInto: string,
): Promise<PushAfterMergeOutcome> {
  const deploy = project.settings?.deploy;
  if (!isCiSetUp(project) || !deploy?.repo) return { pushed: false };
  const main = await resolveMainBranch(project, deps.branches);
  // Only the project's main branch goes to GitHub, never a merge into some other branch
  if (!main || mergedInto !== main) return { pushed: false };
  const branch = main;
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
