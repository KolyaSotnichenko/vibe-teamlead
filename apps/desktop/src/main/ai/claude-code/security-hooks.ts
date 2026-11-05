/**
 * PreToolUse hooks that enforce Vibe Teamlead's security model on Claude Code.
 *
 * - Bash commands go through the existing allowlist validator (`bashSecurityHook`),
 *   which already emits Claude Code's hook output format.
 * - File writes are always confined: to `allowedWritePaths` when the session
 *   sets them (spec agents and the architect write only inside the spec
 *   directory), otherwise to the working directory (the task's worktree), the
 *   spec directory and the temp directory. Symlinks are resolved, so a link
 *   inside the worktree can't point a write outside it.
 * - The QA reviewer reviews; the QA fixer fixes. The reviewer writes only in
 *   the spec directory (its report, the spec checklists, screenshots) and
 *   neither stages nor commits: a problem in the code is a finding for the fixer.
 */

import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';

import type { HookCallbackMatcher, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { bashSecurityHook } from '../security/bash-validator';
import { splitCommandSegments } from '../security/command-parser';
import { isPathContained } from '../security/path-containment';
import type { ToolContext } from '../tools/types';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const REVIEWER_RULE = "The QA reviewer doesn't change project code: record this as an issue in qa_report.md for the QA fixer.";

/** Git subcommands that change the index or the history; the reviewer only looks. */
const REVIEWER_GIT_DENIED = new Set(['add', 'commit']);

/** Global git options that take a value, so the subcommand comes after it. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** The git subcommand of one command segment, or null when it isn't a git command. */
function gitSubcommand(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/);
  const start = tokens.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (start === -1) return null;
  let skipNext = false;
  for (const token of tokens.slice(start + 1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

/** Exported for unit tests: does this Bash command stage or commit? */
export function reviewerBashDenied(command: string): boolean {
  return splitCommandSegments(command).some((segment) => {
    const sub = gitSubcommand(segment);
    return sub !== null && REVIEWER_GIT_DENIED.has(sub);
  });
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Each starts agents on the next QA run, so an agent must not be able to leave one for itself. */
const APP_REQUEST_FILES = new Set(['qa_fix_request.md', 'qa_rerun']);

/** Directories a session may write to. */
export function writeRoots(context: ToolContext): string[] {
  if (context.allowedWritePaths?.length) return context.allowedWritePaths;
  return [context.cwd, context.specDir, tmpdir()].filter(Boolean);
}

/** Exported for unit tests. */
export function evaluatePreToolUse(
  toolName: string,
  toolInput: Record<string, unknown> | null,
  context: ToolContext,
): HookJSONOutput {
  if (toolName === 'Bash') {
    const result = bashSecurityHook(
      { toolName, toolInput, cwd: context.cwd },
      context.securityProfile,
    );
    if ('hookSpecificOutput' in result) {
      return deny(result.hookSpecificOutput.permissionDecisionReason);
    }
    const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
    if (context.agentType === 'qa_reviewer' && reviewerBashDenied(command)) {
      return deny(`git add and git commit are denied. ${REVIEWER_RULE}`);
    }
    return {};
  }

  if (WRITE_TOOLS.has(toolName)) {
    const raw = (toolInput?.file_path ?? toolInput?.notebook_path) as string | undefined;
    if (raw) {
      const target = isAbsolute(raw) ? resolve(raw) : resolve(context.cwd, raw);
      if (APP_REQUEST_FILES.has(basename(target).toLowerCase())) {
        return deny(`${basename(target)} is a request from the app or the user to QA; agents don't write it. Record your findings in qa_report.md.`);
      }
      if (context.agentType === 'qa_reviewer' && !isPathContained(target, context.specDir).contained) {
        return deny(`${toolName} to ${raw} denied. ${REVIEWER_RULE} Your spec directory is ${context.specDir}.`);
      }
      const roots = writeRoots(context);
      if (!roots.some((root) => isPathContained(target, root).contained)) {
        return deny(`Write denied: ${toolName} cannot write to ${raw}. Allowed directories: ${roots.join(', ')}`);
      }
    }
  }

  return {};
}

export function buildSecurityHooks(context: ToolContext): HookCallbackMatcher[] {
  return [
    {
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const { tool_name, tool_input } = input as PreToolUseHookInput;
          const toolInput =
            tool_input && typeof tool_input === 'object' && !Array.isArray(tool_input)
              ? (tool_input as Record<string, unknown>)
              : null;
          return evaluatePreToolUse(tool_name, toolInput, context);
        },
      ],
    },
  ];
}
