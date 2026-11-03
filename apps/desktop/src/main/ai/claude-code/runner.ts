/**
 * Claude Code session runner
 * ==========================
 *
 * Every Vibe Teamlead agent (spec, planner, coder, QA...) runs as a Claude Code
 * session through the Claude Agent SDK. This module turns a SessionConfig into
 * SDK options, streams the session, and returns the same SessionResult /
 * StreamEvent contract the orchestration layer and UI already consume.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { getAgentConfig } from '../config/agent-configs';
import { ErrorCode } from '../session/error-classifier';
import type { SessionConfig, SessionEventCallback, SessionResult } from '../session/types';
import { CODEGRAPH_SERVER_KEY, codegraphMcpServer, ensureCodegraphIndex } from './codegraph';
import { SessionAccumulator } from './event-mapper';
import { buildMcpServers } from './mcp-servers';
import { buildSecurityHooks } from './security-hooks';
import { skillsForAgent, SUPERPOWERS_INSTRUCTIONS } from './skills';
import { ASK_USER_INSTRUCTIONS, buildAskUserHook, type AskUserHandler } from './user-questions';

/** Claude Code built-in tools Vibe Teamlead agents may be given */
const CLAUDE_CODE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookEdit',
]);

export interface RunnerOptions {
  /** Callback for streaming events (text, tool calls, progress) */
  onEvent?: SessionEventCallback;
  /** Shows agent questions to the user; omit for unattended sessions */
  askUser?: AskUserHandler;
  /** Diagnostic log lines (indexing, setup) */
  onLog?: (line: string) => void;
}

/** Map an agent's configured tool list onto Claude Code tool names. */
export function resolveBuiltinTools(configTools: readonly string[], hasSubagents: boolean): string[] {
  const tools = new Set<string>();
  for (const name of configTools) {
    if (name === 'SpawnSubagent') {
      tools.add('Agent');
    } else if (CLAUDE_CODE_TOOLS.has(name)) {
      tools.add(name);
    }
  }
  if (tools.has('Write') || tools.has('Edit')) tools.add('TodoWrite');
  if (hasSubagents) tools.add('Agent');
  tools.add('Skill');
  tools.add('AskUserQuestion');
  return [...tools];
}

function buildPrompt(config: SessionConfig): string {
  const userTurns = config.initialMessages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim())
    .filter(Boolean);
  return userTurns.length > 0 ? userTurns.join('\n\n') : 'Begin the task described in your instructions.';
}

/** Host variables Claude Code and MCP servers legitimately need. */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TERM',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const;

/** Claude Code config home owned by Vibe Teamlead (bundled plugins live here, not in ~/.claude). */
export function defaultClaudeConfigDir(): string {
  return join(homedir(), '.vibe-teamlead', 'claude-code');
}

/**
 * Build an isolated environment for the Claude Code process.
 *
 * The SDK would otherwise inherit everything from the host — including a
 * personal claude.ai login (`~/.claude`, CLAUDE_CODE_* variables) that can
 * silently take precedence over the configured API key. Only an allowlist of
 * host variables is passed through, auth is always the configured key, and
 * Claude Code gets its own config directory.
 */
export function buildEnv(config: SessionConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of INHERITED_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.ANTHROPIC_API_KEY = config.auth.apiKey;
  if (config.auth.baseURL) env.ANTHROPIC_BASE_URL = config.auth.baseURL;
  env.CLAUDE_CONFIG_DIR = config.claudeConfigDir ?? defaultClaudeConfigDir();
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.DISABLE_TELEMETRY = '1';
  return env;
}

export interface QueryExtras {
  askUser?: AskUserHandler;
  /** CodeGraph index is ready for this session's working directory */
  codegraphReady?: boolean;
}

export function buildQueryOptions(
  config: SessionConfig,
  abortController: AbortController,
  extras: QueryExtras = {},
): Options {
  const agentConfig = getAgentConfig(config.agentType);
  const hasSubagents = !!config.agents && Object.keys(config.agents).length > 0;
  const bundled = config.bundled ?? {};
  const tools = resolveBuiltinTools(agentConfig.tools, hasSubagents);

  const mcpServers = buildMcpServers(config.agentType, config.toolContext, config.mcpOptions, {
    specDir: config.specDir,
    memoryMcpUrl: config.memoryMcpUrl,
    linearApiKey: config.linearApiKey,
  });
  if (bundled.codegraphBin && extras.codegraphReady && tools.includes('Read')) {
    mcpServers[CODEGRAPH_SERVER_KEY] = codegraphMcpServer(bundled.codegraphBin, config.toolContext.cwd);
  }

  const plugins = [...(config.plugins ?? [])];
  const skills = bundled.superpowersDir ? skillsForAgent(config.agentType) : [];
  if (bundled.superpowersDir) plugins.push({ type: 'local', path: bundled.superpowersDir });

  const append = [config.systemPrompt, ASK_USER_INSTRUCTIONS, skills.length ? SUPERPOWERS_INSTRUCTIONS : '']
    .filter(Boolean)
    .join('\n');

  const options: Options = {
    model: config.model,
    cwd: config.toolContext.cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    tools,
    mcpServers,
    // Agents run unattended inside an isolated worktree; safety comes from the
    // PreToolUse hooks (command allowlist + write-path containment).
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    hooks: {
      PreToolUse: [...buildSecurityHooks(config.toolContext), buildAskUserHook(extras.askUser)],
    },
    skills,
    maxTurns: config.maxSteps,
    abortController,
    includePartialMessages: true,
    settingSources: config.settingSources ?? ['project'],
    persistSession: false,
    env: buildEnv(config),
  };

  if (config.thinkingLevel) options.effort = config.thinkingLevel;
  if (hasSubagents) options.agents = config.agents;
  if (plugins.length) options.plugins = plugins;
  if (bundled.claudeCodeExecutable) options.pathToClaudeCodeExecutable = bundled.claudeCodeExecutable;
  if (config.outputSchema) {
    options.outputFormat = {
      type: 'json_schema',
      schema: z.toJSONSchema(config.outputSchema as z.ZodType) as Record<string, unknown>,
    };
  }

  return options;
}

/**
 * Run one agent session on Claude Code.
 *
 * Never throws for model/auth/limit problems — those come back as an outcome
 * on the SessionResult so the orchestrator can decide what to do next.
 */
export async function runAgentSession(
  config: SessionConfig,
  options: RunnerOptions = {},
): Promise<SessionResult> {
  const startTime = Date.now();
  const emit = options.onEvent ?? (() => undefined);
  const acc = new SessionAccumulator(emit, config.initialMessages);

  if (!config.auth.apiKey) {
    const error = {
      code: ErrorCode.AUTH_FAILURE,
      message: 'No Anthropic API key configured. Add one in Settings → Claude account.',
      retryable: false,
    };
    emit({ type: 'error', error });
    return {
      outcome: 'auth_failure',
      stepsExecuted: 0,
      usage: acc.usage,
      error,
      messages: acc.messages,
      durationMs: Date.now() - startTime,
      toolCallCount: 0,
    };
  }

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (config.abortSignal?.aborted) abortController.abort();
  config.abortSignal?.addEventListener('abort', onAbort, { once: true });

  const codegraphBin = config.bundled?.codegraphBin;
  const codegraphReady = codegraphBin
    ? ensureCodegraphIndex(codegraphBin, config.toolContext.cwd, options.onLog)
    : false;

  let thrown: unknown;
  try {
    const stream = query({
      prompt: buildPrompt(config),
      options: buildQueryOptions(config, abortController, { askUser: options.askUser, codegraphReady }),
    });
    for await (const message of stream) {
      acc.handle(message);
    }
  } catch (error) {
    thrown = error;
  } finally {
    config.abortSignal?.removeEventListener('abort', onAbort);
  }

  const { outcome, error } = acc.resolveOutcome(abortController.signal.aborted, thrown);
  if (error) emit({ type: 'error', error });

  let structuredOutput: Record<string, unknown> | undefined;
  if (config.outputSchema && acc.result?.subtype === 'success' && acc.result.structured_output !== undefined) {
    const parsed = config.outputSchema.safeParse(acc.result.structured_output);
    if (parsed.success) structuredOutput = parsed.data as Record<string, unknown>;
  }

  return {
    outcome,
    stepsExecuted: acc.stepsExecuted,
    usage: acc.usage,
    error,
    messages: acc.messages,
    durationMs: Date.now() - startTime,
    toolCallCount: acc.toolCallCount,
    structuredOutput,
    costUsd: acc.costUsd,
    claudeSessionId: acc.sessionId,
  };
}
