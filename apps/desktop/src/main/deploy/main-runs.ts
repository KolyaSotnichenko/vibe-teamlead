/**
 * A failed GitHub Actions run on main becomes ONE fix task per workflow (key `run:<workflowPath>`;
 * the first run of a new workflow is just the first run with that path). Runs reach this from the
 * Deploy tab's poller and from a watcher that follows the runs of a just-pushed commit.
 * Logs come from GitHub, which masks repository secrets; nothing else is added to them.
 */
import type { Project } from '../../shared/types';
import type { DeployRun } from '../../shared/types/deploy';
import { createRunFixTask, type DeployTaskDeps, markRunHandled, wasRunHandled } from './deploy-tasks';
import type { ActionsClient } from './github-actions';
import { resolveMainBranch } from './push-after-merge';
import { readReadiness } from './readiness-store';
import { prepareLog } from './runs-poller';

type Timer = unknown;

export interface MainRunDeps {
  client: Pick<ActionsClient, 'runs' | 'jobs' | 'jobLog'>;
  resolveRepo: (project: Project) => Promise<{ owner: string; repo: string } | null>;
  tasks: DeployTaskDeps;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** The project's local branch names (to find main when not configured) */
  branches?: (projectPath: string) => Promise<string[]>;
}

export const WATCH_INTERVAL_MS = 60_000;
export const WATCH_LIMIT_MS = 60 * 60_000;
const LOG_TAIL_LINES = 200;
const RUNS_PER_POLL = 30;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const FAILED_JOB = new Set(['failure', 'timed_out']);

/** Handled-in-flight run ids: the poller and a watcher can see the same run in the same moment */
const inFlight = new Set<string>();

/** Only projects with Deploy on and a saved readiness result take part. */
const active = (project: Project): boolean => !!project.settings?.deploy?.enabled && readReadiness(project.path) !== null;

export async function handleMainRun(
  project: Project,
  run: DeployRun,
  deps: MainRunDeps,
): Promise<'created' | 'open' | 'passed' | 'seen'> {
  if (!active(project) || run.status !== 'completed' || wasRunHandled(project.path, run.id)) return 'seen';
  const lock = `${project.path}|${run.id}`;
  if (inFlight.has(lock)) return 'seen';
  inFlight.add(lock);
  try {
    if (!run.conclusion || !FAILED.has(run.conclusion)) {
      markRunHandled(project.path, run.id);
      return run.conclusion === 'success' ? 'passed' : 'seen';
    }
    const repo = await deps.resolveRepo(project);
    if (!repo) return 'seen';
    const jobs = (await deps.client.jobs(repo.owner, repo.repo, run.id)).filter((j) => j.conclusion && FAILED_JOB.has(j.conclusion));
    const sections: string[] = [];
    for (const job of jobs) {
      let tail = '(the log is not available)';
      try {
        const text = await deps.client.jobLog(repo.owner, repo.repo, job.id);
        if (text) tail = prepareLog(text, LOG_TAIL_LINES);
      } catch {
        // keep the placeholder
      }
      sections.push(`### ${job.name}\n\n\`\`\`\n${tail}\n\`\`\``);
    }
    const name = run.name || run.workflowPath;
    const description = [
      `The ${name} run on main failed.`,
      jobs.length ? `Failed jobs: ${jobs.map((j) => j.name).join(', ')}` : 'GitHub reports no failed job; open the run for details.',
      ...sections,
      `Run: ${run.htmlUrl}`,
      "Fix whichever is wrong, the project or the workflow; don't skip or weaken checks.",
    ].join('\n\n');
    const made = await createRunFixTask(
      project,
      { key: `run:${run.workflowPath}`, title: `Fix the failed ${name} run on main`, description },
      deps.tasks,
    );
    markRunHandled(project.path, run.id);
    return made ? 'created' : 'open';
  } finally {
    inFlight.delete(lock);
  }
}

const watching = new Set<string>();

/** Follows the runs of a pushed commit on main: every 60 s, at most 60 min, until all are completed. Never throws. */
export function watchMainRuns(project: Project, sha: string, deps: MainRunDeps): void {
  const id = `${project.id}|${sha}`;
  if (watching.has(id) || !active(project)) return;
  watching.add(id);
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const started = now();

  const tick = async (): Promise<void> => {
    let done = false;
    try {
      const repo = await deps.resolveRepo(project);
      const main = await resolveMainBranch(project, deps.branches);
      if (repo) {
        const runs = (await deps.client.runs(repo.owner, repo.repo, RUNS_PER_POLL, main)).filter((r) => r.sha === sha && (!main || r.branch === main));
        for (const r of runs) {
          if (r.status !== 'completed') continue;
          try {
            await handleMainRun(project, r, deps);
          } catch {
            // retried on the next poll
          }
        }
        done = runs.length > 0 && runs.every((r) => r.status === 'completed');
      }
    } catch {
      // GitHub unreachable: try again on the next poll
    }
    if (done || now() - started >= WATCH_LIMIT_MS) {
      watching.delete(id);
      return;
    }
    setTimer(() => void tick(), WATCH_INTERVAL_MS);
  };
  void tick();
}
