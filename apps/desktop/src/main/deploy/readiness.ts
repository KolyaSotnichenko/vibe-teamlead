/**
 * CI readiness scan orchestration: one scan per project at a time (more requests while
 * one runs share ONE follow-up), three triggers (first open, after a merge into main,
 * Check again) and blocker tasks from the result. Setup is never started from here: the owner
 * starts it. Nothing here throws into a caller; a failed scan keeps the saved result.
 */
import type { Project } from '../../shared/types';
import type { ReadinessResult, ReadinessState } from '../../shared/types/deploy';
import type { ScanInput } from '../ai/runners/deploy-readiness';
import { createBlockerTasks, type DeployTaskDeps, deployTaskStatus, type GaveUp, gaveUpKeys, openDeployBlockers, resetMissingBlockers } from './deploy-tasks';
import { resolveMainBranch } from './push-after-merge';
import { type KnownBlocker, readReadiness, writeReadiness } from './readiness-store';
import { workflowSecretNames } from './workflow-secrets';

export type ReadinessReason = 'open' | 'check-again' | 'merge';

export const SCAN_FAILED = 'The readiness scan failed. Try again.';

export interface ReadinessDeps {
  scan(input: ScanInput): Promise<ReadinessResult>;
  lastMainRun(project: Project): Promise<ScanInput['lastMainRun']>;
  /** The repository's GitHub Actions secret names (names only) */
  secretNames(project: Project): Promise<string[]>;
  /** The secrets the project's workflows read (`secrets.NAME`); read from its .github/workflows by default. */
  workflowSecretNames?(projectPath: string): Promise<string[]>;
  headCommit(projectPath: string): Promise<string | undefined>;
  tasks: DeployTaskDeps;
  emit(projectId: string, state: ReadinessState): void;
  /** The project's local branch names (to find main when not configured); read from .git files by default. */
  branches?(projectPath: string): Promise<string[]>;
  /** The project as saved now (each scan of a flight re-reads it, so a queued scan sees fresh settings) */
  loadProject?(projectId: string): Project | undefined;
}

interface Flight {
  promise: Promise<void>;
  again: boolean;
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

  /** The saved scan's blockers, then the keys with an open task the saved scan lost: what the scan keeps keys for */
  const knownBlockers = (project: Project, previous: ReadinessResult | null): KnownBlocker[] => {
    const known: KnownBlocker[] = (previous?.blockers ?? [])
      .map((b) => ({ key: b.key, kind: b.kind, subject: b.subject, title: b.title }));
    try {
      for (const open of openDeployBlockers(project, deps.tasks.getTasks, deps.tasks.now?.())) {
        if (!known.some((b) => b.key === open.key)) known.push(open);
      }
    } catch {
      // the saved scan's blockers still count
    }
    return known;
  };

  async function scanOnce(project: Project): Promise<void> {
    const previous = readReadiness(project.path);
    errors.delete(project.id);
    emit(project);
    let result: ReadinessResult;
    try {
      const [secretNames, workflowSecrets, commit, lastMainRun] = await Promise.all([
        // Unknown when the listing fails: the scan then asks for no secret (never every one as missing)
        deps.secretNames(project).catch(() => undefined),
        (deps.workflowSecretNames ?? workflowSecretNames)(project.path).catch(() => [] as string[]),
        deps.headCommit(project.path).catch(() => undefined),
        deps.lastMainRun(project).catch(() => undefined),
      ]);
      const known = knownBlockers(project, previous);
      result = await deps.scan({
        projectPath: project.path,
        ...(known.length ? { knownBlockers: known } : {}),
        ...(commit ? { commit } : {}),
        ...(secretNames ? { secretNames } : {}),
        workflowSecretNames: workflowSecrets,
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
      // (but never while its task is open: a key the scan lost is still being fixed)
      resetMissingBlockers(project.path, result.blockers.map((b) => b.key), deps.tasks.getTasks(project.id), deps.tasks.now?.());
      await createBlockerTasks(project, result.blockers, deps.tasks);
    } catch {
      // the saved result stands; the next scan creates the tasks
    }
    // The result goes out now; the scanning flag clears when the flight ends
    emit(project);
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
