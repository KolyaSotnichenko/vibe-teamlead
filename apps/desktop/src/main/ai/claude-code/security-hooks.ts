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
 */

import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { HookCallbackMatcher, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { bashSecurityHook } from '../security/bash-validator';
import { isPathContained } from '../security/path-containment';
import type { ToolContext } from '../tools/types';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

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
    return {};
  }

  if (WRITE_TOOLS.has(toolName)) {
    const raw = (toolInput?.file_path ?? toolInput?.notebook_path) as string | undefined;
    if (raw) {
      const target = isAbsolute(raw) ? resolve(raw) : resolve(context.cwd, raw);
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
