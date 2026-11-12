/**
 * Deploy readiness scan orchestration: one scan per project at a time (more requests while
 * one runs share ONE follow-up), three triggers (first open, after a merge into main,
 * Check again), blocker tasks from the result, and the automatic setup once the last
 * blocker is gone. Nothing here throws into a caller; a failed scan keeps the saved result.
 */
import type { Project } from '../../shared/types';
import type { ReadinessResult, ReadinessState, ServiceKind } from '../../shared/types/deploy';
import type { ScanInput } from '../ai/runners/deploy-readiness';
import { createBlockerTasks, type DeployTaskDeps, deployTaskStatus, type GaveUp, gaveUpKeys, resetMissingBlockers } from './deploy-tasks';
import { resolveMainBranch } from './push-after-merge';
import { readReadiness, writeReadiness } from './readiness-store';

export type ReadinessReason = 'open' | 'check-again' | 'merge';

export const SCAN_FAILED = 'The readiness scan failed. Try again.';

export interface ReadinessDeps {
  scan(input: ScanInput): Promise<ReadinessResult>;
  lastMainRun(project: Project): Promise<ScanInput['lastMainRun']>;
  variableNames(project: Project): Promise<string[]>;
  headCommit(projectPath: string): Promise<string | undefined>;
  tasks: DeployTaskDeps;
  setUp(project: Project): Promise<unknown>;
  emit(projectId: string, state: ReadinessState): void;
  /** False when setup must wait for the owner (a Vercel account with teams and none chosen for the project). Default: allowed. */
  canAutoSetUp?(project: Project): Promise<boolean>;
  /** The project's local branch names (to find main when not configured); read from .git files by default. */
  branches?(projectPath: string): Promise<string[]>;
  /** The project as saved now (each scan of a flight re-reads it, so a queued scan sees fresh settings) */
  loadProject?(projectId: string): Project | undefined;
}

interface Flight {
  promise: Promise<void>;
  again: boolean;
}

const blocksDeploy = (r: ReadinessResult | null): boolean => !!r?.blockers.some((b) => b.kind === 'code' || b.kind === 'workflow');

export interface AutoSetUpDeps {
  /** Teams of the signed-in Vercel account */
  vercelTeamCount(): Promise<number>;
  resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null>;
  repoVisibility(owner: string, repo: string): Promise<'private' | 'public'>;
}

/**
 * Whether setup may start on its own once the last blocker is gone. Not onto a public repository
 * (recorded as public, or a GitHub origin that is public or whose visibility can't be read): the
 * owner sets that up by hand, after the warning. Not while a Vercel account with teams has no
 * team recorded for the project (R3). Never throws: any failure is false.
 */
export async function autoSetUpAllowed(project: Project, deps: AutoSetUpDeps): Promise<boolean> {
  try {
    const deploy = project.settings?.deploy;
    if (deploy?.repo?.public) return false;
    const repo = await deps.resolveRepo(project);
    if (repo && (await deps.repoVisibility(repo.owner, repo.repo)) !== 'private') return false;
    if (deploy?.vercelTeamId) return true;
    return (await deps.vercelTeamCount()) === 0;
  } catch {
    return false;
  }
}

export function createReadiness(deps: ReadinessDeps) {
  const flights = new Map<string, Flight>();
  const errors = new Map<string, string>();

  const snapshot = (project: Project): ReadinessState => {
    const result = readReadiness(project.path);
    const error = errors.get(project.id);
    let tasks: ReadinessState['tasks'] = {};
    try {
      tasks = deployTaskStatus(project, deps.tasks.getTasks);
    } catch {
      // the task list is informational
    }
    let gaveUp: GaveUp[] = [];
    try {
      gaveUp = gaveUpKeys(project.path);
    } catch {
      // informational
    }
    const links = Object.fromEntries(gaveUp.filter((g) => g.url).map((g) => [g.key, g.url as string]));
    return {
      ...(result ? { result } : {}),
      scanning: flights.has(project.id),
      ...(error ? { error } : {}),
      tasks,
      ...(gaveUp.length ? { gaveUp: gaveUp.map((g) => g.key) } : {}),
      ...(Object.keys(links).length ? { gaveUpLinks: links } : {}),
    };
  };

  const emit = (project: Project) => {
    try {
      deps.emit(project.id, snapshot(project));
    } catch {
      // informational
    }
  };

  async function scanOnce(project: Project): Promise<void> {
    const previous = readReadiness(project.path);
    errors.delete(project.id);
    emit(project);
    let result: ReadinessResult;
    try {
      const deploy = project.settings?.deploy;
      const [variableNames, commit, lastMainRun] = await Promise.all([
        deps.variableNames(project).catch(() => [] as string[]),
        deps.headCommit(project.path).catch(() => undefined),
        deps.lastMainRun(project).catch(() => undefined),
      ]);
      result = await deps.scan({
        projectPath: project.path,
        ...(commit ? { commit } : {}),
        variableNames,
        databaseAdded: !!deploy?.database,
        servicesAdded: Object.keys(deploy?.services ?? {}) as ServiceKind[],
        // Only a run of the commit being scanned says something about it (after a merge, the last run is of the commit before)
        ...(lastMainRun && commit && lastMainRun.sha === commit ? { lastMainRun } : {}),
      });
      writeReadiness(project.path, result);
    } catch {
      errors.set(project.id, SCAN_FAILED);
      emit(project);
      return;
    }
    try {
      // A blocker this scan no longer finds is gone: its fix count starts again
      resetMissingBlockers(project.path, result.blockers.map((b) => b.key));
      await createBlockerTasks(project, result.blockers, deps.tasks);
    } catch {
      // the saved result stands; the next scan creates the tasks
    }
    return finish(project, previous, result);
  }

  async function finish(project: Project, previous: ReadinessResult | null, result: ReadinessResult): Promise<void> {
    // Emit the result before setup (which can take a while); the flag clears when the flight ends
    emit(project);
    if (!blocksDeploy(previous) || blocksDeploy(result) || project.settings?.deploy?.enabled === true) return;
    try {
      if (deps.canAutoSetUp && !(await deps.canAutoSetUp(project))) return;
      await deps.setUp(project);
    } catch {
      // setup reports its own errors; the scan result stands
    }
  }

  async function runFlight(project: Project, flight: Flight): Promise<void> {
    try {
      do {
        flight.again = false;
        let fresh = project;
        try {
          fresh = deps.loadProject?.(project.id) ?? project;
        } catch {
          // the project as the caller passed it
        }
        await scanOnce(fresh);
      } while (flight.again);
    } finally {
      flights.delete(project.id);
      emit(project);
    }
  }

  return {
    state: snapshot,

    async scan(project: Project, reason: ReadinessReason, mergedInto?: string): Promise<void> {
      try {
        const saved = readReadiness(project.path);
        // 'open' asks for a first result only; after a failed scan only Check again retries
        if (reason === 'open' && (saved || errors.has(project.id))) return;
        if (reason === 'merge') {
          if (!saved) return;
          const main = await resolveMainBranch(project, deps.branches);
          if (!main || mergedInto !== main) return;
        }
        const running = flights.get(project.id);
        if (running) {
          // An 'open' joins the running scan: it only asks for a first result, which this scan produces
          if (reason !== 'open') running.again = true;
          return running.promise;
        }
        const flight: Flight = { again: false, promise: Promise.resolve() };
        flights.set(project.id, flight);
        flight.promise = runFlight(project, flight);
        return await flight.promise;
      } catch {
        // never throws into a caller
      }
    },
  };
}

export type Readiness = ReturnType<typeof createReadiness>;
