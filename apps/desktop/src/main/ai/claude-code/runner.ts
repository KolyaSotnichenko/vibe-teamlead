/**
 * Claude Code session runner
 * ==========================
 *
 * Every Vibe Teamlead agent (spec, planner, coder, QA...) runs as a Claude Code
 * session through the Claude Agent SDK. This module turns a SessionConfig into
 * SDK options, streams the session, and returns the same SessionResult /
 * StreamEvent contract the orchestration layer and UI already consume.
 */

import { isMainThread } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { getAgentConfig } from '../config/agent-configs';
import { ErrorCode } from '../session/error-classifier';
import type { SessionConfig, SessionEventCallback, SessionResult } from '../session/types';
import { isSubscriptionToken } from './auth';
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
  if (config.auth.oauthToken) {
    // Personal mode: the owner's own Claude subscription.
    env.CLAUDE_CODE_OAUTH_TOKEN = config.auth.oauthToken;
    // Keep the user's claude.ai connectors out of agent sessions.
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  } else {
    env.ANTHROPIC_API_KEY = config.auth.apiKey;
    if (config.auth.baseURL) env.ANTHROPIC_BASE_URL = config.auth.baseURL;
  }
  env.CLAUDE_CONFIG_DIR = config.claudeConfigDir ?? defaultClaudeConfigDir();
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.DISABLE_TELEMETRY = '1';
  return env;
}

/** The Claude Code tool list a session will run with. */
export function sessionTools(config: SessionConfig): string[] {
  if (config.toolsOverride) return [...config.toolsOverride];
  const hasSubagents = !!config.agents && Object.keys(config.agents).length > 0;
  return resolveBuiltinTools(getAgentConfig(config.agentType).tools, hasSubagents);
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
  const hasSubagents = !!config.agents && Object.keys(config.agents).length > 0;
  const bundled = config.bundled ?? {};
  const tools = sessionTools(config);

  // Tool-less sessions (plain text generation) get no MCP servers either.
  const mcpServers =
    tools.length === 0
      ? {}
      : buildMcpServers(config.agentType, config.toolContext, config.mcpOptions, {
          specDir: config.specDir,
          memoryMcpUrl: config.memoryMcpUrl,
          linearApiKey: config.linearApiKey,
          bundled: {
            playwrightMcpCli: bundled.playwrightMcpCli,
            chromeDevtoolsMcpCli: bundled.chromeDevtoolsMcpCli,
            nodeRuntime: bundled.nodeRuntime,
          },
          browserOutputDir: config.specDir ? join(config.specDir, 'qa-browser') : undefined,
        });
  if (bundled.codegraphBin && extras.codegraphReady && tools.includes('Read')) {
    mcpServers[CODEGRAPH_SERVER_KEY] = codegraphMcpServer(bundled.codegraphBin, config.toolContext.cwd);
  }

  const plugins = [...(config.plugins ?? [])];
  const availablePlugins = new Set<string>();
  if (bundled.superpowersDir) {
    plugins.push({ type: 'local', path: bundled.superpowersDir });
    availablePlugins.add('superpowers');
  }
  if (bundled.vibeSkillsDir) {
    plugins.push({ type: 'local', path: bundled.vibeSkillsDir });
    availablePlugins.add('vibe-teamlead');
  }
  if (bundled.drawioPluginDir) {
    // The skill only; its remote MCP server would send diagrams to draw.io's cloud.
    plugins.push({ type: 'local', path: bundled.drawioPluginDir, skipMcpDiscovery: true });
    availablePlugins.add('drawio');
  }
  const skills = skillsForAgent(config.agentType, availablePlugins);

  const append = [config.systemPrompt, ASK_USER_INSTRUCTIONS, skills.some((s) => s.startsWith('superpowers:')) ? SUPERPOWERS_INSTRUCTIONS : '']
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
      schema: toOutputJsonSchema(config.outputSchema as z.ZodType),
    };
  }

  return options;
}

/**
 * Structured-output schema for Claude Code's --json-schema. Its validator knows
 * draft-07, not zod's default draft 2020-12, and rejects any "$schema" it does
 * not know ("no schema with key or ref …"), so: draft-07, without "$schema".
 */
export function toOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
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

  const { apiKey, oauthToken, rejectedSubscriptionToken } = config.auth;
  const authProblem =
    rejectedSubscriptionToken || isSubscriptionToken(apiKey)
      ? 'Your Claude subscription login is set up, but subscription mode is off. Turn on "Use my Claude subscription" in Settings, or add an Anthropic API key.'
      : !apiKey && !oauthToken
        ? 'No Claude credentials configured. Add an Anthropic API key (Claude Console) in Settings, or turn on "Use my Claude subscription".'
        : undefined;
  if (authProblem) {
    const error = {
      code: ErrorCode.AUTH_FAILURE,
      message: authProblem,
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
  // Pipeline agents (worker thread) wait for the index; main-process tasks never block on it.
  const codegraphReady = codegraphBin && sessionTools(config).includes('Read')
    ? await ensureCodegraphIndex(codegraphBin, config.toolContext.cwd, {
        wait: !isMainThread,
        signal: config.abortSignal,
        log: options.onLog,
      })
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
