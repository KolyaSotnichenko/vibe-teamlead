/**
 * A failed GitHub Actions run on main becomes ONE fix task per workflow (key `run:<workflowPath>`;
 * the first run of a new workflow is just the first run with that path). Runs reach this from the
 * Deploy tab's poller and from a watcher that follows the runs of a just-pushed commit.
 * Logs come from GitHub, which masks repository secrets; nothing else is added to them.
 */
import type { Project, Task } from '../../shared/types';
import type { DeployRun } from '../../shared/types/deploy';
import { isCiSetUp } from './ci-setup';
import { clipLine } from './clip';
import { createRunFixTask, type DeployTaskDeps, markRunHandled, resetFixCount, wasRunHandled } from './deploy-tasks';
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
/** Job and run names in headings and the title: one line, capped */
const NAME_CHARS = 100;
const RUNS_PER_POLL = 30;
const LAST_RUN_LOOKBACK = 20;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const FAILED_JOB = new Set(['failure', 'timed_out']);

/** Not working on anything: done, handed over as a PR, or still in Planning (nobody has started it) */
const NOT_WORKING = new Set(['done', 'pr_created', 'backlog']);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a started, unfinished task already works on this run's failure: a base-fix task (it
 * repairs the project's own checks) when this is the workflow that runs those checks (the
 * readiness scan's workflow path; unknown: no), or a task whose title or description names the
 * workflow file (path or file name), or the workflow as a workflow ("CI run", "CI workflow",
 * "failing CI"; the bare name is too common a word, as in a workflow named Build). Backlog tasks
 * don't count: nobody is on them. Deterministic, from the task list only.
 */
function coveredByOpenTask(run: DeployRun, tasks: Task[], checksWorkflow: string | undefined): boolean {
  const file = run.workflowPath.split('/').pop() ?? '';
  const name = run.name.trim();
  const patterns: RegExp[] = [];
  if (run.workflowPath) patterns.push(new RegExp(escapeRegExp(run.workflowPath), 'i'));
  if (file) patterns.push(new RegExp(`(?:^|[^\\w.-])${escapeRegExp(file)}(?![\\w-])`, 'i'));
  if (name.length >= 2) {
    const n = escapeRegExp(name);
    patterns.push(new RegExp(`(?:^|\\W)${n}\\s+(?:runs?|workflows?|checks?|jobs?|pipelines?|builds?|failures?)\\b`, 'i'));
    patterns.push(new RegExp(`\\b(?:failed|failing|broken|red)\\s+${n}(?:$|\\W)`, 'i'));
  }
  return tasks.some((task) => {
    if (NOT_WORKING.has(task.status)) return false;
    if (task.metadata?.sourceType === 'base-fix') return !!checksWorkflow && checksWorkflow === run.workflowPath;
    const text = `${typeof task.title === 'string' ? task.title : ''}\n${typeof task.description === 'string' ? task.description : ''}`;
    return patterns.some((pattern) => pattern.test(text));
  });
}

/** Handled-in-flight run ids: the poller and a watcher can see the same run in the same moment */
const inFlight = new Set<string>();

/** Only projects set up for CI (the repository step is done) with a saved readiness result take part. */
const active = (project: Project): boolean => isCiSetUp(project) && readReadiness(project.path) !== null;

/** A log tail that cannot close the Markdown fence it is put in. */
const defuse = (text: string): string => text.replace(/`{3,}/g, "'''");

const sameRepo = (a: string | undefined, repo: { owner: string; repo: string }): boolean =>
  !!a && a.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase();

/**
 * Only a push of the project's own repository to main counts: a fork's pull request can carry a
 * head branch named main. Used by the main-run handler, the poller and the readiness scan.
 */
export function isOwnPushOnMain(run: DeployRun, repo: { owner: string; repo: string }, main: string | undefined): boolean {
  return !!main && run.branch === main && run.event === 'push' && sameRepo(run.headRepo, repo);
}

/** The newest completed own push run on main, for the readiness scan; undefined when none or on any failure. */
export async function findLastMainRun(
  project: Project,
  deps: Pick<MainRunDeps, 'client' | 'resolveRepo' | 'branches'>,
): Promise<{ conclusion: string; runId: number; sha: string; failedJobs: string[]; workflowPath?: string } | undefined> {
  try {
    const repo = await deps.resolveRepo(project);
    const main = await resolveMainBranch(project, deps.branches);
    if (!repo || !main) return undefined;
    const runs = await deps.client.runs(repo.owner, repo.repo, LAST_RUN_LOOKBACK, main);
    const run = runs
      .filter((r) => isOwnPushOnMain(r, repo, main) && r.status === 'completed' && r.conclusion)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)[0];
    if (!run?.conclusion) return undefined;
    const jobs = run.conclusion === 'success' ? [] : await deps.client.jobs(repo.owner, repo.repo, run.id);
    return {
      conclusion: run.conclusion,
      runId: run.id,
      sha: run.sha,
      failedJobs: jobs.filter((j) => j.conclusion === 'failure').map((j) => clipLine(j.name, NAME_CHARS)),
      ...(run.workflowPath ? { workflowPath: run.workflowPath } : {}),
    };
  } catch {
    return undefined;
  }
}

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
      if (run.conclusion !== 'success') {
        markRunHandled(project.path, run.id);
        return 'seen';
      }
      // A passing own run: the workflow's fix count starts again
      const repo = await deps.resolveRepo(project);
      if (!repo) return 'seen';
      if (isOwnPushOnMain(run, repo, await resolveMainBranch(project, deps.branches))) resetFixCount(project.path, runKey(run));
      markRunHandled(project.path, run.id);
      return 'passed';
    }
    const repo = await deps.resolveRepo(project);
    if (!repo) return 'seen';
    if (!isOwnPushOnMain(run, repo, await resolveMainBranch(project, deps.branches))) {
      markRunHandled(project.path, run.id);
      return 'seen';
    }
    // Another task is on it already (a base fix, or a task about this workflow): no second one. The
    // run stays unhandled, so it is asked about again and gets its task once that one closes.
    if (coveredByOpenTask(run, deps.tasks.getTasks(project.id), readReadiness(project.path)?.workflow?.path)) return 'open';
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
      sections.push(`### ${clipLine(job.name, NAME_CHARS)}\n\n\`\`\`\n${defuse(tail)}\n\`\`\``);
    }
    const name = clipLine(run.name || run.workflowPath, NAME_CHARS);
    const description = [
      `The ${name} run on main failed.`,
      jobs.length ? `Failed jobs: ${jobs.map((j) => clipLine(j.name, NAME_CHARS)).join(', ')}` : 'GitHub reports no failed job; open the run for details.',
      ...sections,
      `Run: ${run.htmlUrl}`,
      "Fix whichever is wrong, the project or the workflow; don't skip or weaken checks.",
    ].join('\n\n');
    const made = await createRunFixTask(
      project,
      { key: runKey(run), title: `Fix the failed ${name} run on main`, description, url: run.htmlUrl },
      deps.tasks,
    );
    markRunHandled(project.path, run.id);
    return made ? 'created' : 'open';
  } finally {
    inFlight.delete(lock);
  }
}

const runKey = (run: DeployRun): string => `run:${run.workflowPath}`;

const newer = (a: DeployRun, b: DeployRun): boolean => a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.id > b.id);

/**
 * Runs on main: per workflow only the newest completed own push run is acted on; the older ones
 * (already followed by a newer run) are marked handled without a task. A workflow with a newer
 * own push run still going waits for it. `pending`: a failed run could not be processed (a GitHub
 * error) and is retried on the next call. Never throws.
 */
export async function handleMainRuns(project: Project, runs: DeployRun[], deps: MainRunDeps): Promise<{ pending: boolean }> {
  if (!active(project)) return { pending: false };
  const failedCompleted = runs.some((r) => r.status === 'completed' && !!r.conclusion && FAILED.has(r.conclusion));
  let repo: { owner: string; repo: string } | null = null;
  try {
    repo = await deps.resolveRepo(project);
  } catch {
    return { pending: failedCompleted };
  }
  if (!repo) return { pending: failedCompleted };
  const main = await resolveMainBranch(project, deps.branches);
  const newest = new Map<string, DeployRun>();
  const rest: DeployRun[] = [];
  // Per workflow, the newest own push run that is not completed yet: an older failure waits for it
  const unfinished = new Map<string, DeployRun>();
  for (const r of runs) {
    if (r.status === 'completed' || !isOwnPushOnMain(r, repo, main)) continue;
    const best = unfinished.get(r.workflowPath);
    if (!best || newer(r, best)) unfinished.set(r.workflowPath, r);
  }
  for (const r of runs.filter((x) => x.status === 'completed')) {
    if (!isOwnPushOnMain(r, repo, main)) {
      rest.push(r); // handleMainRun marks it handled
      continue;
    }
    const best = newest.get(r.workflowPath);
    if (!best || newer(r, best)) {
      if (best) markRunHandled(project.path, best.id);
      newest.set(r.workflowPath, r);
    } else {
      markRunHandled(project.path, r.id);
    }
  }
  const settled = [...newest.values()].filter((r) => {
    const pending = unfinished.get(r.workflowPath);
    return !pending || !newer(pending, r);
  });
  let pending = false;
  for (const r of [...rest, ...settled]) {
    try {
      await handleMainRun(project, r, deps);
    } catch {
      // retried on the next poll
      if (r.conclusion && FAILED.has(r.conclusion)) pending = true;
    }
  }
  return { pending };
}

interface Watch {
  sha: string;
  timer?: Timer;
}

/** One watcher per project, following the latest pushed sha */
const watching = new Map<string, Watch>();

/**
 * Follows the runs of a pushed commit on main: every 60 s, at most 60 min, until all are completed
 * and every failure among main's runs is processed. A push of another sha replaces the watcher of
 * the project. Never throws.
 */
export function watchMainRuns(project: Project, sha: string, deps: MainRunDeps): void {
  const current = watching.get(project.id);
  if (current?.sha === sha || !active(project)) return;
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  if (current?.timer !== undefined) clearTimer(current.timer);
  const watch: Watch = { sha };
  watching.set(project.id, watch);
  const live = () => watching.get(project.id) === watch;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const started = now();

  const tick = async (): Promise<void> => {
    watch.timer = undefined;
    let done = false;
    try {
      const repo = await deps.resolveRepo(project);
      const main = await resolveMainBranch(project, deps.branches);
      if (repo && live()) {
        const onMain = (await deps.client.runs(repo.owner, repo.repo, RUNS_PER_POLL, main)).filter((r) => !main || r.branch === main);
        if (!live()) return;
        // All of main's recent runs: a failure of this sha is acted on only when it is the newest of its workflow
        const { pending } = await handleMainRuns(project, onMain, deps);
        const runs = onMain.filter((r) => r.sha === sha);
        done = !pending && runs.length > 0 && runs.every((r) => r.status === 'completed');
      }
    } catch {
      // GitHub unreachable: try again on the next poll
    }
    if (!live()) return;
    if (done || now() - started >= WATCH_LIMIT_MS) {
      watching.delete(project.id);
      return;
    }
    watch.timer = setTimer(() => void tick(), WATCH_INTERVAL_MS);
  };
  void tick();
}
