/**
 * When long agent sessions compact, and what the summary keeps
 * ============================================================
 *
 * Every turn re-sends the whole conversation. Opus 4.7+, Sonnet 5+ and Haiku
 * 5.5 run with a 1M window and Claude Code compacts them only at about 967K
 * tokens, so a long designer run kept everything it ever read. Claude Code's
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100K..1M, capped at the model's window;
 * it wins over every setting) sets the window; compaction fires at the window
 * minus the output reserve (≤ 20K) and a 13K buffer.
 *
 * A compaction rebuilds the conversation cache and costs a summary, so it only
 * pays off far above where a session starts (30–40K): measured on planner-mhp,
 * a 200K window cut designer history by about a quarter, while a 100–150K
 * window for the coder (Haiku, ~18 turns, ~60K per turn) cost more in cache
 * writes and summaries than it saved. Coder and QA fixer get 200K as a guard
 * for runaway sessions only. Short agents keep Claude Code's default.
 *
 * What the summary must keep is given per role by a PreCompact command hook:
 * Claude Code uses a PreCompact hook's stdout as instructions for the summary.
 */

import type { Settings } from '@anthropic-ai/claude-agent-sdk';

import type { AgentType } from '../config/agent-configs';

/** Auto-compact window per agent type (tokens); absent = Claude Code's default. */
export const AUTO_COMPACT_WINDOW: Partial<Record<AgentType, number>> = {
  designer: 200_000,
  coder: 200_000,
  qa_fixer: 200_000,
};

export function autoCompactWindow(agentType: AgentType): number | undefined {
  return AUTO_COMPACT_WINDOW[agentType];
}

/** One line each: the hook prints them with `echo '…'` in bash, zsh or PowerShell. */
const INSTRUCTIONS: Partial<Record<AgentType, string>> = {
  coder:
    'Summarize for the coder who continues this subtask. Keep: the subtask id and its acceptance criteria; the failing test written for it, its file and the exact command that runs it, and whether it is red or green now; every file you changed and why; decisions and dead ends; what is left to do before the subtask is done (refactor, typecheck, commit). Drop file contents and command output that are no longer needed: they can be read again.',
  designer:
    'Summarize for the designer who continues this run. Keep: the frames done and the frames left, each with its file path; every comment and answer from the owner, word for word; design-system decisions (tokens, type scale, spacing, colors, components) and the files they live in; the next step. Drop file contents and tool output that are no longer needed: they can be read again.',
  qa_fixer:
    'Summarize for the QA fixer who continues this run. Keep: each issue from the QA report, fixed or left, with its file; every file you changed and why; the test and check commands and their latest result; what is left before handing back to QA. Drop file contents and command output that are no longer needed: they can be read again.',
};

/** Characters that would end or change a single-quoted string in bash, zsh or PowerShell. */
const UNSAFE = /['\\\n\r]/;

export function compactInstructions(agentType: AgentType, subtaskId?: string): string | undefined {
  const text = INSTRUCTIONS[agentType];
  if (!text) return undefined;
  const id = subtaskId?.replace(/[^\w.\- ]/g, '').trim();
  return id ? `${text} This session works on subtask ${id}.` : text;
}

/**
 * `echo '<text>'`: Claude Code runs a hook command with bash ($SHELL on macOS,
 * so zsh) or, on Windows, Git Bash (PowerShell without it). One line in single
 * quotes, with no quote or backslash, prints the same in all of them. Pure.
 */
export function echoCommand(text: string): string {
  if (UNSAFE.test(text)) throw new Error('compaction instructions must be one line without quotes or backslashes');
  return `echo '${text}'`;
}

/** Flag settings for the session: the PreCompact hook that prints the role's instructions. */
export function compactSettings(agentType: AgentType, subtaskId?: string): Settings | undefined {
  const text = compactInstructions(agentType, subtaskId);
  if (!text) return undefined;
  return { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: echoCommand(text) }] }] } };
}
