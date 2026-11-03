/**
 * Claude Code tasks for the app's utility features
 * ================================================
 *
 * The build pipeline runs long agent sessions from a worker thread. Everything
 * else that needs Claude — titles, commit messages, changelogs, insights,
 * ideation, roadmap, PR/MR review, merge resolution — goes through
 * `runClaudeTask()`: one Claude Code session with an explicit tool set,
 * optional structured output, and the same API-key auth and bundled tools.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ZodSchema } from 'zod';

import type { AgentType } from '../config/agent-configs';
import { resolveModelId } from '../config/phase-config';
import type { ThinkingLevel } from '../config/types';
import { getSecurityProfile } from '../security/security-profile';
import type { ClaudeAuth, SessionEventCallback, SessionResult } from '../session/types';
import { type BundledTools, resolveBundledTools } from './bundled-tools';
import { resolveClaudeAuth } from './credential';
import { runAgentSession } from './runner';
import type { AskUserHandler } from './user-questions';

/** Read-only exploration tools */
export const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** Read + web research */
export const RESEARCH_TOOLS = [...READ_TOOLS, 'WebFetch', 'WebSearch'] as const;
/** Full editing tools */
export const EDIT_TOOLS = [...READ_TOOLS, 'Write', 'Edit', 'Bash'] as const;

export interface ClaudeTaskOptions<T = unknown> {
  /** Role / instructions for this task */
  systemPrompt: string;
  /** The user request */
  prompt: string;
  /** Model shorthand ('haiku' | 'sonnet' | 'opus') or full model id. Default: 'sonnet' */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Claude Code tools. Default: none (single-shot text generation).
   * Use READ_TOOLS / RESEARCH_TOOLS / EDIT_TOOLS or an explicit list.
   */
  tools?: readonly string[];
  /** Working directory (project or worktree). Required when tools are given. */
  cwd?: string;
  /** Spec directory when the task belongs to a spec */
  specDir?: string;
  /** Restrict Write/Edit to these directories */
  allowedWritePaths?: string[];
  /** Agent type, for MCP servers / skills when tools are given. Default: 'insights' */
  agentType?: AgentType;
  /** Structured output schema (validated) */
  outputSchema?: ZodSchema<T>;
  /** Max agentic turns. Default: 3 without tools, 50 with tools */
  maxTurns?: number;
  abortSignal?: AbortSignal;
  onEvent?: SessionEventCallback;
  askUser?: AskUserHandler;
  /** Override credentials (tests, or callers that already resolved them) */
  auth?: ClaudeAuth;
  /** Override bundled tool paths (tests) */
  bundled?: BundledTools;
}

export interface ClaudeTaskResult<T = unknown> {
  /** Final assistant text */
  text: string;
  /** Validated structured output when `outputSchema` was given */
  output?: T;
  session: SessionResult;
}

export class ClaudeTaskError extends Error {
  constructor(
    message: string,
    readonly session: SessionResult,
  ) {
    super(message);
    this.name = 'ClaudeTaskError';
  }
}

let scratchDir: string | undefined;
function taskScratchDir(): string {
  scratchDir ??= mkdtempSync(join(tmpdir(), 'vibe-teamlead-task-'));
  return scratchDir;
}

export async function runClaudeTask<T = unknown>(options: ClaudeTaskOptions<T>): Promise<ClaudeTaskResult<T>> {
  const tools = [...(options.tools ?? [])];
  if (tools.length > 0 && !options.cwd) {
    throw new Error('runClaudeTask: `cwd` is required when tools are enabled');
  }
  const cwd = options.cwd ?? taskScratchDir();

  const session = await runAgentSession(
    {
      agentType: options.agentType ?? 'insights',
      model: resolveModelId(options.model ?? 'sonnet'),
      auth: options.auth ?? resolveClaudeAuth(),
      systemPrompt: options.systemPrompt,
      initialMessages: [{ role: 'user', content: options.prompt }],
      toolContext: {
        cwd,
        projectDir: cwd,
        specDir: options.specDir ?? cwd,
        securityProfile: tools.includes('Bash') ? getSecurityProfile(cwd) : (undefined as never),
        allowedWritePaths: options.allowedWritePaths,
      },
      maxSteps: options.maxTurns ?? (tools.length > 0 ? 50 : 3),
      thinkingLevel: options.thinkingLevel,
      abortSignal: options.abortSignal,
      specDir: options.specDir ?? cwd,
      projectDir: cwd,
      outputSchema: options.outputSchema,
      toolsOverride: tools,
      // Text generation must not pick up the project's CLAUDE.md or skills.
      settingSources: tools.length > 0 ? ['project'] : [],
      bundled: options.bundled ?? resolveBundledTools(),
    },
    { onEvent: options.onEvent, askUser: options.askUser },
  );

  const text = [...session.messages]
    .reverse()
    .find((m) => m.role === 'assistant')
    ?.content.trim() ?? '';

  if (session.outcome !== 'completed' && session.outcome !== 'max_steps') {
    throw new ClaudeTaskError(session.error?.message ?? `Claude task failed (${session.outcome})`, session);
  }
  if (options.outputSchema && session.structuredOutput === undefined) {
    throw new ClaudeTaskError('Claude did not return valid structured output', session);
  }

  return { text, output: session.structuredOutput as T | undefined, session };
}
