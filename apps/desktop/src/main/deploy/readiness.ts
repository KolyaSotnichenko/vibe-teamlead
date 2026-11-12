/**
 * Deploy readiness scan orchestration: one scan per project at a time (more requests while
 * one runs share ONE follow-up), three triggers (first open, after a merge into main,
 * Check again), blocker tasks from the result, and the automatic setup once the last
 * blocker is gone. Nothing here throws into a caller; a failed scan keeps the saved result.
 */
import type { Project } from '../../shared/types';
import type { ReadinessResult, ReadinessState } from '../../shared/types/deploy';
import type { ScanInput } from '../ai/runners/deploy-readiness';
import { createBlockerTasks, type DeployTaskDeps, deployTaskStatus } from './deploy-tasks';
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
}

interface Flight {
  promise: Promise<void>;
  again: boolean;
}

const blocksDeploy = (r: ReadinessResult | null): boolean => !!r?.blockers.some((b) => b.kind === 'code' || b.kind === 'workflow');

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
    return { ...(result ? { result } : {}), scanning: flights.has(project.id), ...(error ? { error } : {}), tasks };
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
        servicesAdded: [],
        ...(lastMainRun ? { lastMainRun } : {}),
      });
      writeReadiness(project.path, result);
    } catch {
      errors.set(project.id, SCAN_FAILED);
      emit(project);
      return;
    }
    try {
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
        await scanOnce(project);
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
        if (reason === 'open' && saved) return;
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
