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
 * - The QA reviewer reviews; the QA fixer fixes. For the reviewer this is a
 *   role guard against drifting into the fixer's job, not a sandbox: it denies
 *   Write/Edit/MultiEdit/NotebookEdit outside the spec directory and every git
 *   command that isn't on a short read-only list. Bash can still write files
 *   (sed -i, cat >, redirections), which this hook does not inspect; the QA loop
 *   compares the worktree's git status before and after the session and
 *   reports the project files the reviewer changed.
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

/** Git subcommands that only read; the reviewer gets no other. */
const REVIEWER_GIT_ALLOWED = new Set([
  'diff', 'log', 'show', 'status', 'rev-parse', 'ls-files', 'blame', 'grep',
  'describe', 'rev-list', 'cat-file', 'name-rev', 'merge-base',
]);

/** `git branch` arguments that only list; anything else may create, rename or delete one. */
const BRANCH_LIST_ARGS = ['--list', '-a', '-r', '-v', '--show-current'];

/** Global git options that alias commands or point git at another repository. */
const GIT_OPTIONS_DENIED = ['-c', '--config-env', '-C', '--git-dir', '--work-tree', '--exec-path'];

/** Interpreters and runners that can hide a git command inside their arguments. */
const WRAPPERS = new Set(['sh', 'bash', 'zsh', 'eval', 'xargs', 'env']);

const isGit = (token: string) => token === 'git' || token.endsWith('/git');

/**
 * Is this one segment of a Bash command read-only git, or no git at all? A
 * best-effort tokenizer on whitespace: the segment splitter and this don't
 * understand every quoting form, so a wrapper with git anywhere in it is denied
 * outright rather than parsed.
 */
function reviewerSegmentAllowed(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const command = tokens[0].replace(/^.*\//, '');
  if (WRAPPERS.has(command)) return !/\bgit\b/.test(segment);
  const start = tokens.findIndex(isGit);
  if (start === -1) return true;
  const args = tokens.slice(start + 1);
  if (args.some((t) => GIT_OPTIONS_DENIED.some((opt) => t === opt || t.startsWith(`${opt}=`)))) return false;
  const subIndex = args.findIndex((t) => !t.startsWith('-'));
  if (subIndex === -1) return false;
  const sub = args[subIndex];
  const rest = args.slice(subIndex + 1);
  if (REVIEWER_GIT_ALLOWED.has(sub)) return true;
  if (sub === 'branch') return rest.every((t) => BRANCH_LIST_ARGS.some((ok) => t === ok || t.startsWith(`${ok}=`)));
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'remote') return rest.length === 1 && rest[0] === '-v';
  if (sub === 'worktree') return rest[0] === 'list';
  return false;
}

/** Exported for unit tests: does this Bash command do anything with git besides reading? */
export function reviewerBashDenied(command: string): boolean {
  return splitCommandSegments(command).some((segment) => !reviewerSegmentAllowed(segment));
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
      return deny(`Only read-only git commands (diff, log, show, status, blame, …) are allowed here. ${REVIEWER_RULE}`);
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
