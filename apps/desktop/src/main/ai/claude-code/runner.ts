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
import { basename, join } from 'node:path';

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { searchPath } from '../../platform/exec';
import { billingOf, recordUsage } from '../usage/usage-ledger';
import { getAgentConfig } from '../config/agent-configs';
import { MODEL_ID_MAP } from '../config/types';
import { ErrorCode } from '../session/error-classifier';
import type { SessionConfig, SessionEventCallback, SessionResult } from '../session/types';
import { isSubscriptionToken } from './auth';
import { CODEGRAPH_SERVER_KEY, codegraphMcpServer, ensureCodegraphIndex } from './codegraph';
import { SessionAccumulator } from './event-mapper';
import { buildMcpServers } from './mcp-servers';
import { removeBrokenBrowserServers } from './browser-servers';
import { recordTurnLimit } from './turn-limits';
import { buildSecurityHooks } from './security-hooks';
import { buildBackgroundTaskHooks, buildDevServerGuard } from './background-tasks';
import { buildFormatLintHook, FORMAT_LINT_AGENTS } from './format-lint-hook';
import { pickHostEnv, SESSION_HOST_ENV } from './host-env';
import { FRONTEND_DESIGN_INSTRUCTIONS, FRONTEND_DESIGN_SKILL, skillsForAgent, SUPERPOWERS_INSTRUCTIONS, UX_REVIEW_INSTRUCTIONS, UX_REVIEW_SKILL } from './skills';
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

/**
 * A background command left running keeps the session open until it times
 * out, then wakes the agent for one more full-context turn just to say so.
 */
export const BACKGROUND_INSTRUCTIONS = `
## Background processes
Start long-running commands (dev servers, watchers, emulators) with Bash \`run_in_background\` and keep the task id it returns. Stop each one with TaskStop as soon as you no longer need it, and always before your final report. Killing the process by PID is not enough: the background task stays open, keeps this session alive and wakes you up later for nothing.`;

/** Every turn re-sends everything so far: fewer turns and smaller results are what make a session cheap. */
export const CONTEXT_INSTRUCTIONS = `
## Keeping your context small
Every turn re-sends everything before it. Read files with Read, not cat or sed. Put independent calls (several reads, searches, checks) in one message. Filter what a command prints: never a bare \`ps aux\` or \`lsof\`; pipe test and build logs through \`tail\` or \`grep\`. Leave generated folders (node_modules, dist, .next, build output) out of searches.`;

const QA_AGENTS = new Set(['qa_reviewer', 'qa_fixer']);

/**
 * QA is told which browser tools this session really has, so it never probes
 * for one that isn't there ("No such tool available"). Pure.
 */
export function browserToolsSection(
  agentType: string,
  serverKeys: string[],
  caps: { is_web_frontend?: boolean; is_electron?: boolean } | undefined,
  /** false when the task changed no UI file, so the servers were left out on purpose */
  taskTouchesUi?: boolean,
): string {
  if (!QA_AGENTS.has(agentType)) return '';
  const have = serverKeys.filter((k) => k === 'playwright' || k === 'electron' || k === 'chrome-devtools');
  if (have.length) {
    return `\n## Browser tools in this session\nAvailable: ${have.map((k) => `\`mcp__${k}__*\``).join(', ')}. No other browser tools exist (no Puppeteer).`;
  }
  const why = !(caps?.is_web_frontend || caps?.is_electron)
    ? 'this project has no web or desktop UI'
    : taskTouchesUi === false
      ? 'this task changed no UI file, so visual verification is N/A'
      : 'the browser server is turned off, not bundled in this build, or could not start';
  return `\n## Browser tools in this session\nNone (${why}). Don't call any \`mcp__playwright__*\`, \`mcp__chrome-devtools__*\`, \`mcp__electron__*\` or Puppeteer tool. Skip visual verification, verify behaviour with tests, \`curl\` and the code, and say in the report that visual checks were not possible.`;
}

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
  // Background commands (dev servers, watchers) must be stoppable, or they hold the session open
  if (tools.has('Bash')) tools.add('TaskStop');
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

/** Claude Code variables that pick the model behind an alias or for background calls. */
const MODEL_ALIAS_ENV = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
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
  const env: Record<string, string | undefined> = pickHostEnv(SESSION_HOST_ENV);
  // An app started from Finder gets a bare PATH: add Homebrew, Docker Desktop,
  // nvm/volta/pnpm and friends so agents' Bash (docker, pnpm, node) and stdio
  // MCP servers (npx) find what the user has installed.
  env.PATH = searchPath();
  if (config.auth.oauthToken) {
    // Personal mode: the owner's own Claude subscription.
    env.CLAUDE_CODE_OAUTH_TOKEN = config.auth.oauthToken;
    // Keep the user's claude.ai connectors out of agent sessions.
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  } else {
    env.ANTHROPIC_API_KEY = config.auth.apiKey;
    if (config.auth.baseURL) env.ANTHROPIC_BASE_URL = config.auth.baseURL;
  }
  // A model that is not Claude (e.g. Ollama behind the base URL): Claude Code's
  // own background calls and the opus/sonnet/haiku aliases (subagents) would
  // otherwise ask the endpoint for Claude models it does not serve.
  if (config.model && !config.model.startsWith('claude-') && !(config.model in MODEL_ID_MAP)) {
    for (const name of MODEL_ALIAS_ENV) env[name] = config.model;
  }
  // Settings → Agents → Subagents: the model of subagents the agent starts itself
  if (config.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = config.subagentModel;
  env.CLAUDE_CONFIG_DIR = config.claudeConfigDir ?? defaultClaudeConfigDir();
  // The LSP tool is behind a feature flag in some Claude Code versions; harmless where it isn't
  if (config.lspPluginDir) env.ENABLE_LSP_TOOL = '1';
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
  /** A browser server that won't be in this session */
  onProblem?: (message: string) => void;
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
      : removeBrokenBrowserServers(buildMcpServers(config.agentType, config.toolContext, config.mcpOptions, {
          specDir: config.specDir,
          memoryMcpUrl: config.memoryMcpUrl,
          linearApiKey: config.linearApiKey,
          bundled: {
            playwrightMcpCli: bundled.playwrightMcpCli,
            chromeDevtoolsMcpCli: bundled.chromeDevtoolsMcpCli,
            nodeRuntime: bundled.nodeRuntime,
          },
          browserOutputDir: config.specDir ? join(config.specDir, 'qa-browser') : undefined,
        }), extras.onProblem);
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
  if (bundled.frontendDesignDir && config.extraSkills?.includes(FRONTEND_DESIGN_SKILL)) {
    plugins.push({ type: 'local', path: bundled.frontendDesignDir });
    availablePlugins.add('frontend-design');
  }
  if (bundled.uxReviewDir && config.extraSkills?.includes(UX_REVIEW_SKILL)) {
    plugins.push({ type: 'local', path: bundled.uxReviewDir });
    availablePlugins.add('ux-review');
  }
  // Language servers (lsp-registry.ts): diagnostics after edits and the LSP tool
  if (config.lspPluginDir) {
    plugins.push({ type: 'local', path: config.lspPluginDir });
    if (!tools.includes('LSP')) tools.push('LSP');
  }
  const available = (s: string) => availablePlugins.has(s.split(':')[0]);
  const baseSkills = config.skillsOverride ? config.skillsOverride.filter(available) : skillsForAgent(config.agentType, availablePlugins);
  const skills = [...baseSkills, ...(config.extraSkills ?? []).filter((s) => available(s) && !baseSkills.includes(s))];

  const append = [
    config.systemPrompt,
    ASK_USER_INSTRUCTIONS,
    skills.some((s) => s.startsWith('superpowers:')) ? SUPERPOWERS_INSTRUCTIONS : '',
    skills.includes(FRONTEND_DESIGN_SKILL) ? FRONTEND_DESIGN_INSTRUCTIONS : '',
    skills.includes(UX_REVIEW_SKILL) ? UX_REVIEW_INSTRUCTIONS : '',
    tools.includes('Bash') ? BACKGROUND_INSTRUCTIONS : '',
    tools.includes('Bash') ? CONTEXT_INSTRUCTIONS : '',
    browserToolsSection(config.agentType, Object.keys(mcpServers), config.mcpOptions?.projectCapabilities, config.mcpOptions?.taskTouchesUi),
  ]
    .filter(Boolean)
    .join('\n');

  // Hold the final stop until the agent has stopped the background tasks it started
  const background = tools.includes('Bash') ? buildBackgroundTaskHooks() : undefined;
  // Format and lint each file the coder / QA fixer writes, with the project's own tools
  const formatLint =
    config.formatOnEdit !== false && FORMAT_LINT_AGENTS.has(config.agentType) && (tools.includes('Edit') || tools.includes('Write'))
      ? buildFormatLintHook({ agentType: config.agentType, cwd: config.toolContext.cwd, projectDir: config.toolContext.projectDir })
      : undefined;
  const postToolUse = [...(background?.PostToolUse ?? []), ...(formatLint ? [formatLint] : [])];

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
      PreToolUse: [
        ...buildSecurityHooks({ ...config.toolContext, agentType: config.agentType }),
        buildAskUserHook(extras.askUser),
        ...(tools.includes('Bash') && getAgentConfig(config.agentType).appTools?.includes('mcp__vibe-teamlead__start_dev_server') ? [buildDevServerGuard()] : []),
      ],
      ...(postToolUse.length ? { PostToolUse: postToolUse } : {}),
      ...(background ? { PostToolUseFailure: background.PostToolUseFailure, Stop: background.Stop } : {}),
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
const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/**
 * One line per finished session for the task log: turns, tool calls and
 * tokens by kind, so a session that burns tokens is visible. Pure — tested directly.
 */
export function sessionSummary(
  agentType: string,
  outcome: string,
  turns: number,
  toolCalls: number,
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  maxTurns: number,
): string {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const input = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
  const parts = [
    `${agentType} session ${outcome}: ${turns} turn${turns === 1 ? '' : 's'}, ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`,
    `tokens in ${kTokens(input)}, cache read ${kTokens(cacheRead)}, cache write ${kTokens(cacheWrite)}, out ${kTokens(usage.completionTokens)}`,
  ];
  if (usage.promptTokens > 50_000 && cacheRead === 0) parts.push('no prompt caching (every turn paid the whole context)');
  if (outcome === 'max_steps') parts.push(`stopped at the ${maxTurns}-turn limit`);
  return parts.join(' · ');
}

/**
 * Lines for MCP servers that did not start (their tools are missing, and
 * the agent gets "No such tool available" when it calls them). Pure — tested directly.
 */
export function mcpStartupProblems(servers: Array<{ name: string; status: string }> | undefined): string[] {
  return (servers ?? [])
    .filter((s) => s.status === 'failed' || s.status === 'needs-auth')
    .map((s) => `MCP server "${s.name}" did not start (${s.status}): its tools are not available in this session.`);
}

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
      options: buildQueryOptions(config, abortController, { askUser: options.askUser, codegraphReady, onProblem: options.onLog }),
    });
    for await (const message of stream) {
      acc.handle(message);
      if (message.type === 'system' && message.subtype === 'init') {
        for (const line of mcpStartupProblems(message.mcp_servers)) options.onLog?.(line);
      }
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

  // Token usage per project (header counter); best effort, never fails the session
  await recordUsage(config.toolContext.projectDir ?? config.toolContext.cwd, {
    at: new Date().toISOString(),
    agentType: config.agentType,
    model: config.model,
    input: Math.max(0, acc.usage.promptTokens - (acc.usage.cacheReadTokens ?? 0) - (acc.usage.cacheCreationTokens ?? 0)),
    output: acc.usage.completionTokens,
    cacheRead: acc.usage.cacheReadTokens ?? 0,
    cacheWrite: acc.usage.cacheCreationTokens ?? 0,
    costUsd: acc.costUsd ?? 0,
    ...billingOf(config.auth),
    ...(config.specDir ? { specId: basename(config.specDir) } : {}),
    outcome,
    turns: acc.stepsExecuted,
    toolCalls: acc.toolCallCount,
    durationMs: Date.now() - startTime,
  });

  if (outcome === 'max_steps' && config.specDir) {
    recordTurnLimit(config.specDir, { agentType: config.agentType, subtaskId: config.subtaskId, limit: config.maxSteps });
  }

  options.onLog?.(sessionSummary(config.agentType, outcome, acc.stepsExecuted, acc.toolCallCount, acc.usage, config.maxSteps));

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
