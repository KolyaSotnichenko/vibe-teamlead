/**
 * The agent that makes a task work with the latest main branch, in the task's
 * folder. It has tools and can run the project's checks; git-level checks on its
 * work are in merge/integrate-task.ts.
 */

import { EDIT_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ThinkingLevel } from '../config/types';
import type { IntegrationAgentAnswer, IntegrationAgentRequest } from '../merge/integrate-task';
import { loadPrompt } from '../prompts/prompt-loader';
import type { StreamEvent } from '../session/types';

const MAX_TURNS = 80;
/** A stuck agent would hold up every task behind it in the queue */
const TIMEOUT_MS = 30 * 60_000;
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
}

export async function runMergeIntegrator(options: MergeIntegratorOptions): Promise<IntegrationAgentAnswer> {
  const { worktreePath, baseBranch, conflictFiles, taskTitle, model, thinkingLevel, onEvent, timeoutMs = TIMEOUT_MS } = options;
  const conflicts = conflictFiles.length
    ? `Git could not merge these files, and they are in conflict now:\n${conflictFiles.map((file) => `- ${JSON.stringify(file)}`).join('\n')}`
    : 'Git merged everything without a conflict. Only check the result, and fix what it broke.';
  const abortSignal = AbortSignal.timeout(timeoutMs);
  // The stop is a request: the wait ends here whether or not the session listens
  const stopped = new Promise<never>((_, reject) => {
    abortSignal.addEventListener('abort', () => reject(new Error(`The agent was stopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing.`)), { once: true });
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
  const { text } = await Promise.race([session, stopped]);
  return parseVerdict(text);
}
