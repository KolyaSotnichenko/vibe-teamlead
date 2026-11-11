/**
 * Polls one project's GitHub Actions runs and pushes the state to the window.
 * One project at a time; errors are data in the state, the poller never throws.
 */
import type { Project } from '../../shared/types';
import type {
  DeployDeployment,
  DeployJob,
  DeployJobLog,
  DeployRun,
  DeployRunsState,
  GitHubError,
} from '../../shared/types/deploy';
import type { ActionsClient } from './github-actions';
import { buildRunGraph } from './run-graph';

type Repo = { owner: string; repo: string };
type Timer = unknown;

export interface RunsPollerDeps {
  client: Pick<ActionsClient, 'runs' | 'jobs' | 'workflowFile' | 'deployments' | 'productionUrl'>;
  resolveRepo: (project: Project) => Promise<Repo | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  emit: (state: DeployRunsState) => void;
}

const ACTIVE_MS = 5_000;
const IDLE_MS = 60_000;
const PRODUCTION_URL_MS = 60_000;

interface Session {
  project: Project;
  generation: number;
  selectedRunId?: number;
  timer?: Timer;
  repo?: Repo;
  last?: DeployRunsState;
  workflowCache: Map<string, string | null>;
  productionUrl?: string | null;
  productionUrlAt?: number;
}

const asGitHubError = (e: unknown): GitHubError => {
  const kind = (e as GitHubError | null)?.kind;
  if (typeof kind === 'string' && typeof (e as GitHubError).message === 'string') return e as GitHubError;
  return { kind: 'unavailable', message: e instanceof Error ? e.message : 'Could not reach GitHub' };
};

/** A job's log for the renderer: 404 is not there yet, anything else that fails is gone. */
export async function fetchJobLog(
  client: Pick<ActionsClient, 'jobLog'>,
  repo: Repo,
  jobId: number
): Promise<DeployJobLog> {
  try {
    const text = await client.jobLog(repo.owner, repo.repo, jobId);
    return text === null ? { state: 'pending' } : { state: 'ready', text };
  } catch {
    return { state: 'expired' };
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

  async function workflowYaml(s: Session, repo: Repo, run: DeployRun): Promise<string | null> {
    if (!run.workflowPath) return null;
    const key = `${run.workflowPath}@${run.sha}`;
    if (s.workflowCache.has(key)) return s.workflowCache.get(key) ?? null;
    try {
      const yaml = await deps.client.workflowFile(repo.owner, repo.repo, run.workflowPath, run.sha);
      s.workflowCache.set(key, yaml);
      return yaml;
    } catch {
      return null; // the graph falls back to the flat list; retried next tick
    }
  }

  async function refreshProductionUrl(s: Session, repo: Repo): Promise<void> {
    if (s.productionUrlAt !== undefined && now() - s.productionUrlAt < PRODUCTION_URL_MS) return;
    s.productionUrlAt = now();
    try {
      s.productionUrl = await deps.client.productionUrl(repo.owner, repo.repo);
    } catch {
      // keep the last known value
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
    try {
      const repo = s.repo as Repo;
      runs = await deps.client.runs(repo.owner, repo.repo);
      if (!current()) return;
      const run = runs.find((r) => r.id === s.selectedRunId) ?? runs[0];
      s.selectedRunId = run?.id;
      selected = undefined;
      if (run) {
        const jobs: DeployJob[] = await deps.client.jobs(repo.owner, repo.repo, run.id);
        const yaml = await workflowYaml(s, repo, run);
        const deployments: DeployDeployment[] = await deps.client.deployments(repo.owner, repo.repo, run.sha);
        selected = { runId: run.id, jobs, graph: buildRunGraph(yaml, jobs, deployments) };
      }
      await refreshProductionUrl(s, repo);
    } catch (e) {
      error = asGitHubError(e);
    }
    if (!current()) return;

    const delay = delayFor(runs, error);
    const state: DeployRunsState = {
      projectId: s.project.id,
      repo: s.repo,
      runs,
      selected,
      productionUrl: s.productionUrl,
      nextPollAt: new Date(now() + delay).toISOString(),
    };
    if (error) state.error = error;
    s.last = state;
    s.timer = setTimer(() => void tick(s), delay);
    deps.emit(state);
  }

  async function begin(s: Session): Promise<void> {
    let repo: Repo | null = null;
    try {
      repo = await deps.resolveRepo(s.project);
    } catch {
      repo = null;
    }
    if (session !== s) return;
    if (!repo) {
      deps.emit({ projectId: s.project.id, runs: [], nextPollAt: new Date(now()).toISOString() });
      return;
    }
    s.repo = repo;
    await tick(s);
  }

  return {
    start(project: Project, selectedRunId?: number): void {
      if (session) halt(session);
      session = { project, generation: 0, selectedRunId, workflowCache: new Map() };
      void begin(session);
    },

    select(runId: number): void {
      const s = session;
      if (!s || s.selectedRunId === runId) return;
      s.selectedRunId = runId;
      if (!s.repo) return;
      const rateLimited =
        s.last?.error?.kind === 'rate-limit' &&
        s.last.error.resetAt !== undefined &&
        Date.parse(s.last.error.resetAt) > now();
      if (!rateLimited) void tick(s);
    },

    stop(projectId: string): void {
      if (!session || session.project.id !== projectId) return;
      halt(session);
      session = null;
    },
  };
}
