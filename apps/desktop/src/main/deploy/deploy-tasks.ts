/**
 * Tasks the Deploy readiness scan and failing runs create: one open task per key, so scanning
 * again (or two callers at once) doesn't pile up duplicates. Same pattern as base-fix tasks
 * (ipc-handlers/task/base-fix-handler.ts). The ledger file also holds the handled run ids
 * (written by the runs poller) and the keys given up on, so every write keeps them.
 *
 * A problem fixed twice that comes back a third time gets no third task: its key is given up
 * and shown to the owner. The count starts again when the problem goes away (a passing run of
 * the workflow, a scan without the blocker).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Project, Task, TaskMetadata } from '../../shared/types';
import type { ReadinessBlocker } from '../../shared/types/deploy';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { writeFileReplacingSync } from '../ai/safe-write';

export interface DeployTaskDeps {
  getTasks(projectId: string): Task[];
  createTask(project: Project, title: string, description: string, metadata: TaskMetadata): Promise<Task>;
  /** Starts a task at once, past the queue: only urgent fixes (a failing run on main) */
  startTask(taskId: string): Promise<void>;
  /** Puts a task in the queue: it starts when the project's parallel-task limit has a free slot */
  queueTask(taskId: string): Promise<void>;
  /** The user's default models for a new task */
  defaultModels?(): Partial<TaskMetadata>;
  now?(): Date;
}

/** What a key fixes: a code or workflow blocker of the scan, or a failing run (`run:<workflow path>`) */
export type DeployKeyKind = 'code' | 'workflow' | 'run';

interface LedgerTask {
  key: string;
  specId: string;
  at: string;
  kind?: DeployKeyKind;
  /** The problem went away after this task: it no longer counts toward giving up */
  settled?: boolean;
}

export interface GaveUp {
  key: string;
  /** The last failed run, for a run key */
  url?: string;
}

interface Ledger {
  tasks: LedgerTask[];
  handledRuns: number[];
  gaveUp: GaveUp[];
}

const MAX_TASKS = 200;
/** Closed tasks for one key before Vibe Teamlead stops trying */
const MAX_FIXES = 2;
/** A task this young that the (cached) task list doesn't show yet is still being set up: open */
const FRESH_MS = 60_000;
/** Done or handed over as a PR: no longer fixing anything */
const CLOSED = new Set(['done', 'pr_created']);
/** project|key being created right now: two callers can report it in the same moment */
const creating = new Set<string>();

const FIXED_TEXT = "Found by the Deploy readiness scan; fix what blocks deploying to Vercel. Don't delete, skip or weaken tests.";

const ledgerPath = (projectPath: string) => path.join(projectPath, '.vibe-teamlead', 'deploy', 'tasks.json');

function readLedger(projectPath: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(projectPath), 'utf-8')) as Partial<Ledger>;
    return {
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
      handledRuns: Array.isArray(parsed?.handledRuns) ? parsed.handledRuns : [],
      gaveUp: Array.isArray(parsed?.gaveUp) ? parsed.gaveUp.filter((g) => typeof g?.key === 'string') : [],
    };
  } catch {
    return { tasks: [], handledRuns: [], gaveUp: [] };
  }
}

function writeLedger(projectPath: string, ledger: Ledger): void {
  const file = ledgerPath(projectPath);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileReplacingSync(file, JSON.stringify(ledger, null, 2));
}

const MAX_HANDLED_RUNS = 100;

/** Whether a run on main was already looked at (the ledger keeps the last 100 ids). */
export function wasRunHandled(projectPath: string, runId: number): boolean {
  return readLedger(projectPath).handledRuns.includes(runId);
}

/** Remembers a run id; the task entries of the ledger stay as they are. */
export function markRunHandled(projectPath: string, runId: number): void {
  const ledger = readLedger(projectPath);
  if (ledger.handledRuns.includes(runId)) return;
  ledger.handledRuns = [...ledger.handledRuns, runId].slice(-MAX_HANDLED_RUNS);
  writeLedger(projectPath, ledger);
}

function recordTask(projectPath: string, key: string, kind: DeployKeyKind, specId: string, now: Date): void {
  const ledger = readLedger(projectPath);
  ledger.tasks = [...ledger.tasks.filter((t) => t.specId !== specId), { key, specId, at: now.toISOString(), kind }].slice(-MAX_TASKS);
  writeLedger(projectPath, ledger);
}

/** Entries written before kinds were recorded: a run key or a scan key (blockerKey puts the kind first) */
const kindOf = (entry: LedgerTask): DeployKeyKind | undefined =>
  entry.kind ?? (entry.key.startsWith('run:') ? 'run' : entry.key.startsWith('workflow') ? 'workflow' : undefined);

const isOpenEntry = (entry: LedgerTask, tasks: Task[], now: Date): boolean => {
  const task = tasks.find((t) => t.specId === entry.specId);
  if (task) return !CLOSED.has(task.status);
  const age = now.getTime() - Date.parse(entry.at);
  return Number.isFinite(age) && age >= 0 && age < FRESH_MS;
};

/** Creates one task for a key and queues it (or starts it now, `start: 'now'`) unless one is open or being created, or the key is given up. */
async function createKeyed(
  project: Project,
  key: string,
  kind: DeployKeyKind,
  title: string,
  description: string,
  extra: Partial<TaskMetadata>,
  deps: DeployTaskDeps,
  opts: { url?: string; blockedBy?: DeployKeyKind; start?: 'now' | 'queue' } = {},
): Promise<boolean> {
  const lock = `${project.path}|${key}`;
  if (creating.has(lock)) return false;
  const now = deps.now?.() ?? new Date();
  const tasks = deps.getTasks(project.id);
  const ledger = readLedger(project.path);
  const mine = ledger.tasks.filter((entry) => entry.key === key);
  if (mine.some((entry) => isOpenEntry(entry, tasks, now))) return false;
  // A workflow blocker and a failing run are often the same failure: one task at a time
  if (opts.blockedBy && ledger.tasks.some((entry) => kindOf(entry) === opts.blockedBy && isOpenEntry(entry, tasks, now))) return false;
  const fixes = mine.filter((entry) => !entry.settled && tasks.some((t) => t.specId === entry.specId && CLOSED.has(t.status))).length;
  if (fixes >= MAX_FIXES) {
    giveUp(project.path, key, opts.url);
    return false;
  }
  creating.add(lock);
  try {
    const created = await deps.createTask(project, title, description, {
      ...(deps.defaultModels?.() ?? {}),
      sourceType: 'deploy',
      deployKey: key,
      ...extra,
    });
    recordTask(project.path, key, kind, created.specId, now);
    if (opts.start === 'now') await deps.startTask(created.id);
    else await deps.queueTask(created.id);
    return true;
  } finally {
    creating.delete(lock);
  }
}

function giveUp(projectPath: string, key: string, url: string | undefined): void {
  const ledger = readLedger(projectPath);
  const entry: GaveUp = url ? { key, url } : { key };
  const current = ledger.gaveUp.find((g) => g.key === key);
  if (current && current.url === entry.url) return;
  ledger.gaveUp = [...ledger.gaveUp.filter((g) => g.key !== key), entry];
  writeLedger(projectPath, ledger);
}

/** Keys Vibe Teamlead stopped fixing (two fixes and the problem is still there). */
export function gaveUpKeys(projectPath: string): GaveUp[] {
  return readLedger(projectPath).gaveUp;
}

/** The problem of these keys went away: their past tasks no longer count and they are not given up. */
function settle(projectPath: string, settles: (key: string) => boolean): void {
  const ledger = readLedger(projectPath);
  let changed = false;
  for (const entry of ledger.tasks) {
    if (!entry.settled && settles(entry.key)) {
      entry.settled = true;
      changed = true;
    }
  }
  const gaveUp = ledger.gaveUp.filter((g) => !settles(g.key));
  if (gaveUp.length !== ledger.gaveUp.length) changed = true;
  if (!changed) return;
  writeLedger(projectPath, { ...ledger, gaveUp });
}

/** A key's problem is gone (its workflow's newest run passed): the count starts again. */
export function resetFixCount(projectPath: string, key: string): void {
  settle(projectPath, (k) => k === key);
}

/** A scan found these blocker keys: every other scan key's count starts again (run keys are left alone). */
export function resetMissingBlockers(projectPath: string, present: string[]): void {
  const found = new Set(present);
  settle(projectPath, (k) => !k.startsWith('run:') && !found.has(k));
}

/**
 * One task per code or workflow blocker without an open task, put in the queue: a scan can find
 * several blockers, and they wait for the project's parallel-task limit like any task. Returns the
 * keys it created.
 */
export async function createBlockerTasks(project: Project, blockers: ReadinessBlocker[], deps: DeployTaskDeps): Promise<string[]> {
  const keys: string[] = [];
  for (const blocker of blockers) {
    if (blocker.kind === 'unsupported') continue;
    const workflow = blocker.kind === 'workflow';
    let description = `${blocker.detail}\n\n${FIXED_TEXT}`;
    if (workflow) {
      const rules = tryLoadPrompt('deploy_workflow_rules');
      if (rules) description += `\n\n${rules}`;
    }
    const made = await createKeyed(
      project,
      blocker.key,
      blocker.kind,
      blocker.title,
      description,
      { category: workflow ? 'infrastructure' : 'bug_fix', priority: 'high' },
      deps,
      // A run-fix task open for a workflow already works on it
      workflow ? { blockedBy: 'run' } : {},
    );
    if (made) keys.push(blocker.key);
  }
  return keys;
}

/**
 * An urgent task for a failing run; false when its key already has an open task, a workflow
 * blocker task is open, or the key is given up (`url`, the run, is kept for the owner).
 */
export function createRunFixTask(
  project: Project,
  fix: { key: string; title: string; description: string; url?: string },
  deps: DeployTaskDeps,
): Promise<boolean> {
  return createKeyed(project, fix.key, 'run', fix.title, fix.description, { category: 'bug_fix', priority: 'urgent' }, deps, {
    blockedBy: 'workflow',
    // Urgent: main is broken, so it starts at once like a base-fix task
    start: 'now',
    ...(fix.url ? { url: fix.url } : {}),
  });
}

/**
 * Whether the readiness scan created this task (its spec is in the ledger). Task metadata is
 * written by the pipeline agents, so it can't say this; the ledger is written only by the app.
 */
export function isDeployTask(projectPath: string, specId: string): boolean {
  return readLedger(projectPath).tasks.some((entry) => typeof specId === 'string' && entry?.specId === specId);
}

/** Each ledger key's latest task: its spec and current status (undefined when the task is gone). */
export function deployTaskStatus(project: Project, getTasks: DeployTaskDeps['getTasks']): Record<string, { specId: string; status?: string }> {
  const tasks = getTasks(project.id);
  const out: Record<string, { specId: string; status?: string }> = {};
  for (const entry of readLedger(project.path).tasks) {
    out[entry.key] = { specId: entry.specId, status: tasks.find((t) => t.specId === entry.specId)?.status };
  }
  return out;
}
