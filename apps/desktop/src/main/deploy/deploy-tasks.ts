/**
 * Tasks the Deploy readiness scan and failing runs create: one open task per key, so scanning
 * again (or two callers at once) doesn't pile up duplicates. Same pattern as base-fix tasks
 * (ipc-handlers/task/base-fix-handler.ts). The ledger file also holds the handled run ids
 * (written by the runs poller), so every write keeps them.
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
  startTask(taskId: string): Promise<void>;
  /** The user's default models for a new task */
  defaultModels?(): Partial<TaskMetadata>;
  now?(): Date;
}

interface Ledger {
  tasks: Array<{ key: string; specId: string; at: string }>;
  handledRuns: number[];
}

const MAX_TASKS = 200;
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
    };
  } catch {
    return { tasks: [], handledRuns: [] };
  }
}

function recordTask(projectPath: string, key: string, specId: string, now: Date): void {
  const ledger = readLedger(projectPath);
  ledger.tasks = [...ledger.tasks.filter((t) => t.specId !== specId), { key, specId, at: now.toISOString() }].slice(-MAX_TASKS);
  const file = ledgerPath(projectPath);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileReplacingSync(file, JSON.stringify(ledger, null, 2));
}

function isOpenKey(project: Project, key: string, getTasks: DeployTaskDeps['getTasks']): boolean {
  const tasks = getTasks(project.id);
  return readLedger(project.path).tasks.some((entry) => entry.key === key && tasks.some((t) => t.specId === entry.specId && !CLOSED.has(t.status)));
}

/** Creates and starts one task for a key unless one is open or being created. */
async function createKeyed(
  project: Project,
  key: string,
  title: string,
  description: string,
  extra: Partial<TaskMetadata>,
  deps: DeployTaskDeps,
): Promise<boolean> {
  const lock = `${project.path}|${key}`;
  if (creating.has(lock) || isOpenKey(project, key, deps.getTasks)) return false;
  creating.add(lock);
  try {
    const created = await deps.createTask(project, title, description, {
      ...(deps.defaultModels?.() ?? {}),
      sourceType: 'deploy',
      deployKey: key,
      ...extra,
    });
    recordTask(project.path, key, created.specId, deps.now?.() ?? new Date());
    await deps.startTask(created.id);
    return true;
  } finally {
    creating.delete(lock);
  }
}

/** One task per code or workflow blocker without an open task. Returns the keys it created. */
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
      blocker.title,
      description,
      { category: workflow ? 'infrastructure' : 'bug_fix', priority: 'high' },
      deps,
    );
    if (made) keys.push(blocker.key);
  }
  return keys;
}

/** An urgent task for a failing run; false when its key already has an open task. */
export function createRunFixTask(project: Project, fix: { key: string; title: string; description: string }, deps: DeployTaskDeps): Promise<boolean> {
  return createKeyed(project, fix.key, fix.title, fix.description, { category: 'bug_fix', priority: 'urgent' }, deps);
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
