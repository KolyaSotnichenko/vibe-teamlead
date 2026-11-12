/**
 * Polls one project's GitHub Actions runs and pushes the state to the window.
 * One project at a time; errors are data in the state, the poller never throws.
 */
import type { Project } from '../../shared/types';
import type {
  DeployJob,
  DeployJobLog,
  DeployRun,
  DeployRunsState,
  GitHubError,
} from '../../shared/types/deploy';
import type { ActionsClient } from './github-actions';
import { isOwnPushOnMain } from './main-runs';
import { buildRunGraph } from './run-graph';

type Repo = { owner: string; repo: string };
type Timer = unknown;

export interface RunsPollerDeps {
  client: Pick<ActionsClient, 'runs' | 'jobs' | 'workflowFile'>;
  resolveRepo: (project: Project) => Promise<Repo | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  emit: (state: DeployRunsState) => void;
  /** Gets the own push runs on the project's main branch, unfinished ones too (it picks the newest per workflow); may see the same runs again. Errors are swallowed. */
  handleMainRuns?: (project: Project, runs: DeployRun[]) => Promise<unknown>;
  /** The branch whose runs go to handleMainRun */
  mainBranch?: (project: Project) => Promise<string | undefined>;
}

const ACTIVE_MS = 5_000;
const IDLE_MS = 60_000;
const WORKFLOW_RETRY_MS = 60_000;

interface Session {
  project: Project;
  generation: number;
  selectedRunId?: number;
  timer?: Timer;
  repo?: Repo;
  last?: DeployRunsState;
  workflowCache: Map<string, string | null>;
  /** Failed workflow fetches by path@sha: when, and the error. */
  workflowFailures: Map<string, { at: number; error: GitHubError }>;
}

const asGitHubError = (e: unknown): GitHubError => {
  const kind = (e as GitHubError | null)?.kind;
  if (typeof kind === 'string' && typeof (e as GitHubError).message === 'string') return e as GitHubError;
  return { kind: 'unavailable', message: e instanceof Error ? e.message : 'Could not reach GitHub' };
};

/** Lines of a job log sent to the renderer; the rest is a link to GitHub. */
export const LOG_LINES = 2000;

// OSC sequences (e.g. hyperlinks: ESC ] ... BEL or ESC \), then CSI sequences (colours, cursor: ESC [ ... final byte),
// then any other two-byte escape.
const ANSI = new RegExp(
  ['\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', '\\u001b\\[[0-?]*[ -/]*[@-~]', '\\u001b[@-Z\\\\-_]'].join('|'),
  'g'
);

/** The last `limit` lines of a log (a trailing newline does not count as a line), without ANSI escape codes. */
export function prepareLog(text: string, limit = LOG_LINES): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return (lines.length > limit ? lines.slice(-limit) : lines).join('\n').replace(ANSI, '');
}

/** A job's log for the renderer: 404 is not there yet, 410 is gone, any other failure is an error the renderer may retry. */
export async function fetchJobLog(
  client: Pick<ActionsClient, 'jobLog'>,
  repo: Repo,
  jobId: number
): Promise<DeployJobLog> {
  try {
    const text = await client.jobLog(repo.owner, repo.repo, jobId);
    return text === null ? { state: 'pending' } : { state: 'ready', text: prepareLog(text) };
  } catch (e) {
    const error = asGitHubError(e);
    return error.kind === 'unavailable' && error.status === 410 ? { state: 'expired' } : { state: 'error', error };
  }
}

export function createRunsPoller(deps: RunsPollerDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let session: Session | null = null;

  function halt(s: Session): void {
    s.generation++;
    if (s.timer !== undefined) clearTimer(s.timer);
    s.timer = undefined;
  }

  function delayFor(runs: DeployRun[], error?: GitHubError): number {
    if (error) {
      if (error.kind === 'rate-limit' && error.resetAt) {
        const wait = Date.parse(error.resetAt) - now();
        if (Number.isFinite(wait)) return Math.max(wait, 1_000);
      }
      return IDLE_MS;
    }
    return runs.some((r) => r.status !== 'completed') ? ACTIVE_MS : IDLE_MS;
  }

  /** The workflow file; `unavailable` and `permissions` failures give a flat graph (permissions also an error). */
  async function workflowYaml(
    s: Session,
    repo: Repo,
    run: DeployRun
  ): Promise<{ yaml: string | null; error?: GitHubError }> {
    if (!run.workflowPath) return { yaml: null };
    const key = `${run.workflowPath}@${run.sha}`;
    if (s.workflowCache.has(key)) return { yaml: s.workflowCache.get(key) ?? null };
    const failed = s.workflowFailures.get(key);
    if (failed && now() - failed.at < WORKFLOW_RETRY_MS) {
      return { yaml: null, error: failed.error.kind === 'permissions' ? failed.error : undefined };
    }
    try {
      const yaml = await deps.client.workflowFile(repo.owner, repo.repo, run.workflowPath, run.sha);
      s.workflowCache.set(key, yaml);
      s.workflowFailures.delete(key);
      return { yaml };
    } catch (e) {
      const error = asGitHubError(e);
      if (error.kind !== 'unavailable' && error.kind !== 'permissions') throw error;
      s.workflowFailures.set(key, { at: now(), error });
      return { yaml: null, error: error.kind === 'permissions' ? error : undefined };
    }
  }

  /** Completed runs on main to the main-run handler; never throws. */
  async function handleMainRuns(project: Project, repo: Repo, runs: DeployRun[]): Promise<void> {
    if (!deps.handleMainRuns) return;
    try {
      const main = await deps.mainBranch?.(project);
      if (!main) return;
      // Unfinished runs too: a failure waits while a newer run of its workflow is going
      const own = runs.filter((r) => isOwnPushOnMain(r, repo, main));
      if (own.some((r) => r.status === 'completed')) await deps.handleMainRuns(project, own);
    } catch {
      // informational
    }
  }

  async function tick(s: Session): Promise<void> {
    const generation = ++s.generation;
    if (s.timer !== undefined) clearTimer(s.timer);
    s.timer = undefined;
    const current = () => session === s && s.generation === generation;

    let runs = s.last?.runs ?? [];
    let selected = s.last?.selected;
    let error: GitHubError | undefined;
    let workflowError: GitHubError | undefined;
    try {
      const repo = s.repo as Repo;
      runs = await deps.client.runs(repo.owner, repo.repo);
      if (!current()) return;
      void handleMainRuns(s.project, repo, runs);
      const run = runs.find((r) => r.id === s.selectedRunId) ?? runs[0];
      s.selectedRunId = run?.id;
      if (!run) selected = undefined;
      else {
        const jobs: DeployJob[] = await deps.client.jobs(repo.owner, repo.repo, run.id);
        const wf = await workflowYaml(s, repo, run);
        workflowError = wf.error;
        selected = { runId: run.id, jobs, graph: buildRunGraph(wf.yaml, jobs) };
      }
    } catch (e) {
      error = asGitHubError(e);
    }
    error ??= workflowError;
    if (!current()) return;

    const delay = delayFor(runs, error);
    const state: DeployRunsState = {
      projectId: s.project.id,
      repo: s.repo,
      runs,
      selected,
      nextPollAt: new Date(now() + delay).toISOString(),
    };
    if (error) state.error = error;
    s.last = state;
    s.timer = setTimer(() => void tick(s), delay);
    deps.emit(state);
  }

  async function begin(s: Session): Promise<void> {
    s.timer = undefined;
    let repo: Repo | null = null;
    try {
      repo = await deps.resolveRepo(s.project);
    } catch {
      repo = null;
    }
    if (session !== s) return;
    if (!repo) {
      // Not (yet) a GitHub repository, or git failed: try again on the next idle tick.
      s.timer = setTimer(() => void begin(s), IDLE_MS);
      deps.emit({ projectId: s.project.id, runs: [], nextPollAt: new Date(now() + IDLE_MS).toISOString() });
      return;
    }
    s.repo = repo;
    await tick(s);
  }

  return {
    start(project: Project, selectedRunId?: number): void {
      if (session) halt(session);
      session = { project, generation: 0, selectedRunId, workflowCache: new Map(), workflowFailures: new Map() };
      void begin(session);
    },

    select(projectId: string, runId: number): void {
      const s = session;
      if (!s || s.project.id !== projectId || s.selectedRunId === runId) return;
      s.selectedRunId = runId;
      if (!s.repo) return;
      const rateLimited =
        s.last?.error?.kind === 'rate-limit' &&
        s.last.error.resetAt !== undefined &&
        Date.parse(s.last.error.resetAt) > now();
      if (!rateLimited) void tick(s);
    },

    /** The repo the current session resolved for this project, if any. */
    repoFor(projectId: string): Repo | undefined {
      return session?.project.id === projectId ? session.repo : undefined;
    },

    stopAll(): void {
      if (!session) return;
      halt(session);
      session = null;
    },

    stop(projectId: string): void {
      if (!session || session.project.id !== projectId) return;
      halt(session);
      session = null;
    },
  };
}
