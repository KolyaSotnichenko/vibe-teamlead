/**
 * PreToolUse hooks that enforce Vibe Teamlead's security model on Claude Code.
 *
 * - Bash commands go through the existing allowlist validator (`bashSecurityHook`),
 *   which already emits Claude Code's hook output format.
 * - File writes are confined to `allowedWritePaths` when the session sets them
 *   (e.g. spec agents may only write inside the spec directory).
 */

import { isAbsolute, resolve, sep } from 'node:path';

import type { HookCallbackMatcher, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { bashSecurityHook } from '../security/bash-validator';
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

function isInside(target: string, dir: string): boolean {
  const root = resolve(dir);
  return target === root || target.startsWith(root + sep);
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

  if (WRITE_TOOLS.has(toolName) && context.allowedWritePaths?.length) {
    const raw = (toolInput?.file_path ?? toolInput?.notebook_path) as string | undefined;
    if (raw) {
      const target = isAbsolute(raw) ? resolve(raw) : resolve(context.cwd, raw);
      const allowed = context.allowedWritePaths.some((dir) => isInside(target, dir));
      if (!allowed) {
        return deny(
          `Write denied: ${toolName} cannot write to ${raw}. ` +
            `Allowed directories: ${context.allowedWritePaths.join(', ')}`,
        );
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
