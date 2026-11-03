/**
 * Agent → user questions.
 *
 * Claude Code asks with its AskUserQuestion tool (Superpowers' brainstorming
 * relies on it). Sessions run headless, so a PreToolUse hook intercepts the
 * tool, hands the questions to the app (which shows them in the UI and waits
 * for the user), and returns the answers as the tool's input.
 *
 * With nobody to ask (no handler, or the user dismissed it), the tool is
 * denied with an instruction to proceed on a stated assumption instead of
 * stalling.
 */

import type { HookCallbackMatcher, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import type { AgentAnswers, AgentQuestion } from '../../../shared/types/agent-questions';

export type { AgentAnswers, AgentQuestion, AgentQuestionOption } from '../../../shared/types/agent-questions';

/**
 * Ask the user. Resolve with answers, or `null` if the user dismissed the
 * questions or the session is unattended.
 */
export type AskUserHandler = (questions: AgentQuestion[], signal: AbortSignal) => Promise<AgentAnswers | null>;

/** How long a question may wait for the user (seconds). */
export const QUESTION_TIMEOUT_SECONDS = 24 * 60 * 60;

const NO_ANSWER_REASON =
  'No answer from the user is available right now. Do not stop: choose the most reasonable option, ' +
  'state the assumption explicitly in your output (and in the spec or plan if relevant), and continue.';

export const ASK_USER_INSTRUCTIONS = `
## Asking the user
When you need a decision or information only the user has, call the AskUserQuestion tool (1-4 questions, 2-4 options each, one recommended option first). Never ask questions in plain text: nobody reads your text until the session ends. If the tool tells you no answer is available, proceed on a clearly stated assumption.`;

function allowWith(input: Record<string, unknown>, answers: AgentAnswers): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input, answers },
    },
  };
}

function denyNoAnswer(): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: NO_ANSWER_REASON,
    },
  };
}

export function buildAskUserHook(ask?: AskUserHandler): HookCallbackMatcher {
  return {
    matcher: 'AskUserQuestion',
    timeout: QUESTION_TIMEOUT_SECONDS,
    hooks: [
      async (input, _toolUseId, { signal }) => {
        if (input.hook_event_name !== 'PreToolUse' || !ask) return denyNoAnswer();
        const toolInput = ((input as PreToolUseHookInput).tool_input ?? {}) as Record<string, unknown>;
        const questions = (toolInput.questions ?? []) as AgentQuestion[];
        if (questions.length === 0) return denyNoAnswer();
        try {
          const answers = await ask(questions, signal);
          return answers && Object.keys(answers).length > 0 ? allowWith(toolInput, answers) : denyNoAnswer();
        } catch {
          return denyNoAnswer();
        }
      },
    ],
  };
}
