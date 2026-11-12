/**
 * PreToolUse hooks that enforce Vibe Teamlead's security model on Claude Code.
 *
 * - Bash commands go through the existing denylist validator (`bashSecurityHook`),
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
 *   (sed -i, cat >, redirections), which this hook does not inspect, and the
 *   git check is a best-effort tokenizer, not a shell parser. The real backstop
 *   is the QA loop's content snapshot of the worktree before and after each
 *   reviewer session (reviewer-changes.ts), which reports what the reviewer changed.
 * - The Deploy readiness scan never reads secret files (any `.env*` except example
 *   files, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`) nor anything outside the project
 *   (realpaths): Read takes one such file, Grep only one such file, never a folder.
 */

import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type { HookCallbackMatcher, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { bashSecurityHook } from '../security/bash-validator';
import { splitCommandSegments } from '../security/command-parser';
import { isPathContained } from '../security/path-containment';
import { labelDockerRuns } from '../../utils/task-containers';
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

/** The only options allowed before the subcommand; -c, -C, --git-dir and the rest alias or redirect. */
const GIT_LEADING_OK = new Set(['--no-pager', '-p', '-P', '--no-optional-locks']);

/** Options of read-only subcommands that write a file or run a program. */
const SUB_OPTIONS_DENIED = ['--output', '-O', '--open-files-in-pager', '--ext-diff', '--textconv', '--no-index'];

/** Interpreters and runners that can hide a git command inside their arguments. */
const WRAPPERS = new Set(['sh', 'bash', 'zsh', 'eval', 'xargs', 'env']);

const isGit = (token: string) => token === 'git' || token.endsWith('/git');
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** git named inside a substitution or quotes: whatever it does, it isn't visible to the tokenizer. */
const GIT_HIDDEN = [/\$\([^)]*\bgit\b/, /`[^`]*\bgit\b/, /"[^"]*\bgit\b[^"]*"/, /'[^']*\bgit\b[^']*'/];

/**
 * Is this one segment of a Bash command read-only git, or no git at all? A
 * best-effort tokenizer on whitespace: the segment splitter and this don't
 * understand every quoting form, so a wrapper, a substitution, quotes or a
 * second line with git in it are denied outright rather than parsed.
 */
function reviewerSegmentAllowed(segment: string): boolean {
  if (!/\bgit\b/.test(segment)) return true;
  if (segment.includes('\n') || GIT_HIDDEN.some((re) => re.test(segment))) return false;
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const command = tokens[0].replace(/^.*\//, '');
  if (WRAPPERS.has(command)) return false;
  const start = tokens.findIndex(isGit);
  if (start === -1) return true;
  if (tokens.slice(0, start).some((t) => ENV_ASSIGNMENT.test(t))) return false;
  const args = tokens.slice(start + 1);
  const subIndex = args.findIndex((t) => !t.startsWith('-'));
  if (subIndex === -1) return false;
  if (args.slice(0, subIndex).some((t) => !GIT_LEADING_OK.has(t))) return false;
  const sub = args[subIndex];
  const rest = args.slice(subIndex + 1);
  if (rest.some((t) => SUB_OPTIONS_DENIED.some((opt) => t === opt || t.startsWith(`${opt}=`) || (opt === '-O' && t.startsWith('-O'))))) return false;
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

/**
 * Playwright MCP's run-code tool executes Node code in the server's own process.
 * Its vm context is no boundary, so that code could skip the Bash and write checks here.
 */
const BROWSER_SERVER_CODE = /^mcp__.+__browser_run_code(_unsafe)?$/;

/** Example env files name variables without values: the scan reads these. */
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;

/** A file name that holds secrets: any `.env*` (not an example), `id_rsa*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`. */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('.env')) return !ENV_EXAMPLE.test(n);
  return n.startsWith('id_rsa') || /\.(pem|key|p12|pfx)$/.test(n);
}

const SCAN_SECRET_RULE = 'The readiness scan never reads secret files (.env*, *.pem, *.key, *.p12, *.pfx, id_rsa*) or anything outside the project. Take variable names from the example env files and the code.';

const SCAN_GREP_RULE = 'List files with Glob and Read or Grep one file at a time; .env files are off-limits.';

/** Where a path really leads: symlinks resolved (for a missing file, through its folder). */
function realTarget(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    try {
      return resolve(realpathSync(dirname(target)), basename(target));
    } catch {
      return target;
    }
  }
}

/** The path, or where it leads, names a secret file, or leads out of the project. */
function forbiddenPath(target: string, projectRoot: string): boolean {
  const real = realTarget(target);
  if (isSecretFileName(basename(target)) || isSecretFileName(basename(real))) return true;
  return !isPathContained(real, realTarget(projectRoot)).contained;
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Read, Glob and Grep of the readiness scan. Read: a non-secret file inside the project (realpath).
 * Grep: only one existing regular file of that kind; never a folder (a glob can't be trusted to
 * leave secret files out). Glob lists names only; a secret path is still denied.
 */
function evaluateScanRead(toolName: string, toolInput: Record<string, unknown> | null, context: ToolContext): HookJSONOutput | null {
  const at = (raw: unknown): string | undefined =>
    typeof raw === 'string' && raw ? (isAbsolute(raw) ? resolve(raw) : resolve(context.cwd, raw)) : undefined;
  if (toolName === 'Read') {
    const target = at(toolInput?.file_path);
    return target && forbiddenPath(target, context.cwd) ? deny(SCAN_SECRET_RULE) : null;
  }
  if (toolName === 'Glob') {
    const target = at(toolInput?.path);
    return target && isSecretFileName(basename(realTarget(target))) ? deny(SCAN_SECRET_RULE) : null;
  }
  if (toolName !== 'Grep') return null;
  const target = at(toolInput?.path);
  if (!target || forbiddenPath(target, context.cwd) || !isFile(realTarget(target))) return deny(SCAN_GREP_RULE);
  return null;
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
  if (context.agentType === 'deploy_readiness') {
    const scanned = evaluateScanRead(toolName, toolInput, context);
    if (scanned) return scanned;
  }

  if (BROWSER_SERVER_CODE.test(toolName)) {
    return deny('Running code in the browser server is not allowed. Use browser_click, browser_type, browser_fill_form and browser_snapshot instead.');
  }

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
      return deny(`Only read-only git commands (diff, log, show, status, blame, …) are allowed here, run in the task's folder without -C. ${REVIEWER_RULE}`);
    }
    const labelled = labelDockerRuns(command, context.cwd);
    if (labelled !== command) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, command: labelled } } };
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
