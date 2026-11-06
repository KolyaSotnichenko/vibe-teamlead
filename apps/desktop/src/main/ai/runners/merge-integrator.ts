/**
 * The agent that makes a task work with the latest main branch, in the task's
 * folder. It has tools and can run the project's checks; git-level checks on its
 * work are in merge/integrate-task.ts.
 */

import { EDIT_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ThinkingLevel } from '../config/types';
import { AgentStillRunningError, type IntegrationAgentAnswer, type IntegrationAgentRequest } from '../merge/integrate-task';
import { loadPrompt } from '../prompts/prompt-loader';
import type { StreamEvent } from '../session/types';

const MAX_TURNS = 80;
/** A stuck agent would hold up every task behind it in the queue */
const TIMEOUT_MS = 30 * 60_000;
const STOP_GRACE_MS = 30_000;
const VERDICT = /^\s*\**VERDICT:\s*(OK|FAILED)\b\s*[-–—:]?\s*(.*?)\**\s*$/gm;

/** The agent's last verdict line. Without one it didn't finish, whatever else it said. Pure. */
export function parseVerdict(text: string): IntegrationAgentAnswer {
  const last = [...text.matchAll(VERDICT)].pop();
  if (!last) return { ok: false, summary: 'The agent stopped without saying whether the checks passed.' };
  return { ok: last[1] === 'OK', summary: last[2] || (last[1] === 'OK' ? 'The checks passed.' : 'The agent could not finish the merge.') };
}

export interface MergeIntegratorOptions extends IntegrationAgentRequest {
  worktreePath: string;
  taskTitle: string;
  /** Settings → Agents → Utility */
  model: string;
  thinkingLevel: ThinkingLevel;
  onEvent?: (event: StreamEvent) => void;
  timeoutMs?: number;
  stopGraceMs?: number;
}

export async function runMergeIntegrator(options: MergeIntegratorOptions): Promise<IntegrationAgentAnswer> {
  const { worktreePath, baseBranch, conflictFiles, taskTitle, model, thinkingLevel, onEvent, timeoutMs = TIMEOUT_MS, stopGraceMs = STOP_GRACE_MS } = options;
  const conflicts = conflictFiles.length
    ? `Git could not merge these files, and they are in conflict now:\n${conflictFiles.map((file) => `- ${JSON.stringify(file)}`).join('\n')}`
    : 'Git merged everything without a conflict. Only check the result, and fix what it broke.';
  const abortSignal = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<'timed_out'>((resolve) => {
    abortSignal.addEventListener('abort', () => resolve('timed_out'), { once: true });
  });
  const session = runClaudeTask({
    agentType: 'merge_resolver',
    systemPrompt: loadPrompt('merge_integrator'),
    prompt: `The task: ${JSON.stringify(taskTitle)}\nThe main branch: ${JSON.stringify(baseBranch)}\n\n${conflicts}`,
    model,
    thinkingLevel,
    tools: EDIT_TOOLS,
    cwd: worktreePath,
    allowedWritePaths: [worktreePath],
    maxTurns: MAX_TURNS,
    abortSignal,
    onEvent,
  });
  const first = await Promise.race([session, timedOut]);
  if (first !== 'timed_out') return parseVerdict(first.text);

  // The stop is only a request: until the session has ended, it can still commit in the folder
  const ended = await Promise.race([
    session.then(() => true, () => true),
    new Promise<false>((resolve) => { setTimeout(() => resolve(false), stopGraceMs).unref?.(); }),
  ]);
  const minutes = Math.round(timeoutMs / 60_000);
  if (!ended) throw new AgentStillRunningError(`The agent ran for ${minutes} minutes and did not stop when told to. The next merge starts over and undoes what it did.`);
  throw new Error(`The agent was stopped after ${minutes} minutes without finishing.`);
}
