/**
 * Session Types
 * =============
 *
 * Core type definitions for the agent session runtime.
 * Ported from apps/desktop/src/main/ai/session/types.ts (originally from Python agents/session).
 *
 * - SessionConfig: Everything needed to start an agent session
 * - SessionResult: Outcome of a completed session
 * - StreamEvent: Structured events emitted during streaming
 * - ProgressState: Tracks subtask progress within a session
 */

import type { AgentDefinition, SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { ZodSchema } from 'zod';

import type { BundledTools } from '../claude-code/bundled-tools';
import type { AgentType, McpServerResolveOptions } from '../config/agent-configs';
import type { ModelShorthand, Phase, ThinkingLevel } from '../config/types';
import type { ToolContext } from '../tools/types';

/**
 * Credentials for the Claude Code engine.
 * Vibe Teamlead uses Anthropic API keys (Claude Console) — not claude.ai logins.
 */
export interface ClaudeAuth {
  /** Anthropic API key */
  apiKey?: string;
  /** Optional Anthropic-compatible endpoint (e.g. a gateway or proxy) */
  baseURL?: string;
  /** Claude subscription OAuth token — personal mode only (see claude-code/auth.ts) */
  oauthToken?: string;
  /** A subscription token was found but personal mode is off */
  rejectedSubscriptionToken?: boolean;
}

// =============================================================================
// Session Configuration
// =============================================================================

/**
 * Full configuration for running an agent session.
 * Passed to `runAgentSession()` to start streaming.
 */
export interface SessionConfig {
  /** The agent type determines tools, MCP servers, and thinking defaults */
  agentType: AgentType;
  /** Claude model id or alias (e.g. 'claude-opus-4-6', 'sonnet') */
  model: string;
  /** Credentials passed to the Claude Code engine */
  auth: ClaudeAuth;
  /** System prompt for the session */
  systemPrompt: string;
  /** Initial user message(s) to start the conversation */
  initialMessages: SessionMessage[];
  /** Tool context (cwd, projectDir, specDir, securityProfile) */
  toolContext: ToolContext;
  /** Maximum number of agentic turns (Claude Code `maxTurns`) */
  maxSteps: number;
  /** Thinking level override (defaults to agent config) */
  thinkingLevel?: ThinkingLevel;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Which optional MCP servers to attach (Context7, memory, Linear, browser...) */
  mcpOptions?: McpServerResolveOptions;
  /** Memory MCP URL (Graphiti sidecar), when memory is enabled */
  memoryMcpUrl?: string;
  /** Linear API key, when Linear is enabled */
  linearApiKey?: string;
  /** Programmatic subagents Claude Code may delegate to via its Agent tool */
  agents?: Record<string, AgentDefinition>;
  /** Skills for this session instead of the agent type's (e.g. [] to turn them off) */
  skillsOverride?: string[];
  /** Skills added for this session on top of the agent's own (e.g. frontend-design for a UI subtask) */
  extraSkills?: string[];
  /** Default model of subagents without one of their own (the agent's ad-hoc subagents) */
  subagentModel?: string;
  /** Claude Code plugins to load (e.g. Superpowers), by local path */
  plugins?: SdkPluginConfig[];
  /**
   * Filesystem settings to load (CLAUDE.md, skills, hooks, MCP).
   * Defaults to ['project'] so the target repo's .claude/ setup applies.
   */
  settingSources?: SettingSource[];
  /**
   * Explicit Claude Code tool list, overriding the agent type's tools
   * (e.g. [] for single-shot text generation).
   */
  toolsOverride?: string[];
  /** Tools shipped with the app (Claude Code binary, Superpowers, CodeGraph) */
  bundled?: BundledTools;
  /** Claude Code config directory (defaults to ~/.vibe-teamlead/claude-code) */
  claudeConfigDir?: string;
  /** Format and lint each file the coder / QA fixer writes (Settings → Agent Settings; on unless false) */
  formatOnEdit?: boolean;
  /** Generated LSP plugin directory (lsp-plugin.ts) for sessions that get language servers */
  lspPluginDir?: string;
  /** Spec directory for the current task */
  specDir: string;
  /** Project directory root */
  projectDir: string;
  /** Current phase for model/thinking resolution */
  phase?: Phase;
  /** Model shorthand used (for logging/diagnostics) */
  modelShorthand?: ModelShorthand;
  /** Session number within the current subtask run */
  sessionNumber?: number;
  /** Subtask ID being worked on (if applicable) */
  subtaskId?: string;
  /**
   * Optional Zod schema for structured output. Passed to Claude Code as a
   * JSON Schema `outputFormat`; the result is validated before it is returned.
   */
  outputSchema?: ZodSchema;
}

// =============================================================================
// Session Messages
// =============================================================================

/** Role for session messages */
export type MessageRole = 'user' | 'assistant';

/** A message in the session conversation */
export interface SessionMessage {
  role: MessageRole;
  content: string;
}

// =============================================================================
// Session Result
// =============================================================================

/** Possible outcomes of a session */
export type SessionOutcome =
  | 'completed'        // Session finished normally (all steps used or model stopped)
  | 'error'            // Session ended with an unrecoverable error
  | 'rate_limited'     // Hit provider rate limit (429)
  | 'auth_failure'     // Authentication error (401)
  | 'cancelled'        // Aborted via AbortSignal
  | 'max_steps';       // Reached maxSteps limit

/**
 * Result returned when a session finishes (success or failure).
 */
export interface SessionResult {
  /** How the session ended */
  outcome: SessionOutcome;
  /** Total agentic steps executed */
  stepsExecuted: number;
  /** Total tokens consumed */
  usage: TokenUsage;
  /** Error details (when outcome is 'error', 'rate_limited', or 'auth_failure') */
  error?: SessionError;
  /** The full message history at session end */
  messages: SessionMessage[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Tool calls made during the session */
  toolCallCount: number;
  /**
   * Validated structured output when outputSchema was provided in config.
   * Null if no schema was provided or if structured output extraction failed.
   */
  structuredOutput?: Record<string, unknown>;
  /** Total cost reported by Claude Code (USD) */
  costUsd?: number;
  /** Claude Code session id (for resume/debugging) */
  claudeSessionId?: string;
}

/** Token usage breakdown */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Thinking/reasoning tokens (provider-specific) */
  thinkingTokens?: number;
  /** Cache read tokens (Anthropic prompt caching) */
  cacheReadTokens?: number;
  /** Cache creation tokens (Anthropic prompt caching) */
  cacheCreationTokens?: number;
}

/** Structured error from a session */
export interface SessionError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether this error is retryable */
  retryable: boolean;
  /** Original error (for logging) */
  cause?: unknown;
}

// =============================================================================
// Stream Events
// =============================================================================

/**
 * Structured events emitted during session streaming.
 * Consumed by the main process to update UI and track progress.
 */
export type StreamEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepFinishEvent
  | ErrorEvent
  | UsageUpdateEvent;

/** Incremental text output from the model */
export interface TextDeltaEvent {
  type: 'text-delta';
  text: string;
}

/** Incremental thinking/reasoning output (extended thinking) */
export interface ThinkingDeltaEvent {
  type: 'thinking-delta';
  text: string;
}

/** Model initiated a tool call */
export interface ToolCallEvent {
  type: 'tool-call';
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  /** Set when a subagent made the call: the id of the Agent tool call it runs under */
  parentToolCallId?: string;
}

/** Tool execution completed */
export interface ToolResultEvent {
  type: 'tool-result';
  toolName: string;
  toolCallId: string;
  result: unknown;
  durationMs: number;
  isError: boolean;
  /** Set when a subagent made the call (see ToolCallEvent) */
  parentToolCallId?: string;
}

/** An agentic step completed (model turn + tool calls) */
export interface StepFinishEvent {
  type: 'step-finish';
  stepNumber: number;
  usage: TokenUsage;
}

/** An error occurred during the session */
export interface ErrorEvent {
  type: 'error';
  error: SessionError;
}

/** Cumulative usage update */
export interface UsageUpdateEvent {
  type: 'usage-update';
  usage: TokenUsage;
}

// =============================================================================
// Progress State
// =============================================================================

/**
 * Tracks subtask progress within a session.
 * Used by the orchestrator to determine next actions.
 */
export interface ProgressState {
  /** Current subtask ID being worked on */
  currentSubtaskId: string | null;
  /** Total subtasks in the plan */
  totalSubtasks: number;
  /** Number of completed subtasks */
  completedSubtasks: number;
  /** Number of in-progress subtasks */
  inProgressSubtasks: number;
  /** Whether the build is fully complete */
  isBuildComplete: boolean;
  /** Subtask IDs that are stuck/blocked */
  stuckSubtasks: string[];
}

// =============================================================================
// Session Event Callback
// =============================================================================

/**
 * Callback type for receiving stream events during a session.
 * Used by the worker thread to communicate with the main process.
 */
export type SessionEventCallback = (event: StreamEvent) => void;
