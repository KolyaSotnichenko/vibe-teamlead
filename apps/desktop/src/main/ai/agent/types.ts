/**
 * Agent Worker Types
 * ==================
 *
 * Type definitions for the worker thread communication protocol.
 * These types define the messages exchanged between the main thread
 * (WorkerBridge) and the worker thread (worker.ts).
 */

import type { AgentQuestionRequest } from '../../agent/types';
import type { BundledTools } from '../claude-code/bundled-tools';
import type { AgentAnswers } from '../claude-code/user-questions';
import type { ExecutionProgressData, ProcessType } from '../../../main/agent/types';
import type { SessionConfig, SessionResult, StreamEvent } from '../session/types';

// =============================================================================
// Worker Configuration
// =============================================================================

/**
 * Configuration passed to the worker thread via workerData.
 * Must be serializable (no class instances, functions, or LanguageModel).
 */
export interface WorkerConfig {
  /** Task ID for tracking and event correlation */
  taskId: string;
  /** Project ID for multi-project support */
  projectId?: string;
  /** Process type for exit event classification */
  processType: ProcessType;
  /** Serializable session config (model resolved in worker from these params) */
  session: SerializableSessionConfig;
  /** Agent role prompts directory, resolved in the main process (dev: apps/desktop/prompts, packaged: Resources/prompts) */
  promptsDir: string;
}

/**
 * Serializable version of SessionConfig.
 * Only plain data crosses the worker boundary.
 */
export interface SerializableSessionConfig {
  agentType: SessionConfig['agentType'];
  systemPrompt: string;
  initialMessages: SessionConfig['initialMessages'];
  maxSteps: number;
  specDir: string;
  projectDir: string;
  /** Source spec dir in main project (for worktree → main sync during execution) */
  sourceSpecDir?: string;
  /** The owner's decisions about subtasks the coder gave up on, in the app's data */
  ownerDecisionsFile?: string;
  phase?: SessionConfig['phase'];
  modelShorthand?: SessionConfig['modelShorthand'];
  thinkingLevel?: SessionConfig['thinkingLevel'];
  sessionNumber?: SessionConfig['sessionNumber'];
  subtaskId?: SessionConfig['subtaskId'];
  /** Claude model ID */
  modelId: string;
  /** Tools shipped with the app, resolved in the main process */
  bundled?: BundledTools;
  /** Personal mode: accept a Claude subscription token instead of an API key */
  allowSubscriptionLogin?: boolean;
  /** Security QA (Strix) settings, resolved in the main process */
  securityQa?: import('../security/strix').StrixSettings;
  /** Helper subagents: on/off and their model (resolved in the main process) */
  subagents?: import('../claude-code/subagents').SubagentSettings;
  /** When the architect runs (resolved in the main process from the app settings) */
  architectMode?: import('../../../shared/types/settings').ArchitectMode;
  /** Format and lint after each edit of the coder / QA fixer (resolved in the main process; on unless false) */
  formatOnEdit?: boolean;
  /** Language servers for the coder / QA fixer (resolved in the main process; on unless false) */
  lspEnabled?: boolean;
  /** The project's design system (resolved in the main process; .vibe-teamlead/ is not in worktrees) */
  designSystem?: import('../../../shared/types').DesignSystemInfo;
  /** The app's own run of the project's checks (resolved in the main process); absent when off */
  verification?: { commands?: string[]; env: Record<string, string>; lockDir: string };
  /** The app's Claude credential: an API key, or a subscription token (personal mode only) */
  apiKey?: string;
  /** Optional Anthropic-compatible endpoint */
  baseURL?: string;
  /** MCP options resolved from project settings (serialized for worker) */
  mcpOptions?: {
    context7Enabled?: boolean;
    memoryEnabled?: boolean;
    linearEnabled?: boolean;
    electronMcpEnabled?: boolean;
    browserMcpEnabled?: boolean;
    /** Set per QA session in the worker: false when the task changed no UI file */
    taskTouchesUi?: boolean;
    projectCapabilities?: {
      is_electron?: boolean;
      is_web_frontend?: boolean;
    };
    agentMcpAdd?: string;
    agentMcpRemove?: string;
  };
  /** Enable agentic orchestration mode where the AI drives the pipeline via SpawnSubagent tool */
  useAgenticOrchestration?: boolean;
  /** Tool context serialized fields */
  toolContext: {
    cwd: string;
    projectDir: string;
    specDir: string;
    /**
     * Serialized security profile. SecurityProfile uses Set objects which
     * aren't transferable across worker boundaries, so we serialize to arrays.
     */
    securityProfile?: SerializedSecurityProfile;
  };
}

// =============================================================================
// Worker Messages (worker → main)
// =============================================================================

/** Discriminated union of all messages posted from worker to main thread */
export type WorkerMessage =
  | WorkerLogMessage
  | WorkerErrorMessage
  | WorkerProgressMessage
  | WorkerStreamEventMessage
  | WorkerResultMessage
  | WorkerTaskEventMessage
  | WorkerQuestionMessage
  | WorkerQuestionCancelledMessage
  | WorkerRenderDiagramMessage
  | WorkerMemoryRequestMessage
  | WorkerBaseFailuresMessage;

/** App checks that fail on main too: the main process starts one task to fix main (verification/base-fix.ts) */
export interface WorkerBaseFailuresMessage {
  type: 'base-failures';
  taskId: string;
  projectId?: string;
  data: { failures: import('../verification/base-fix').BaseFailure[]; baseCommit: string };
}

/** Project memory work the worker asks the main process to do (memory lives in main). */
export type MemoryRequest =
  | { op: 'prompt'; query: string; limit?: number }
  | { op: 'search'; query: string; limit?: number }
  | { op: 'remember'; memoryType: string; content: string; files?: string[] }
  | { op: 'insights'; insights: import('../runners/insight-extractor').ExtractedInsights };

export interface WorkerMemoryRequestMessage {
  type: 'memory-request';
  taskId: string;
  requestId: string;
  /** Spec id of the task, for tags and provenance */
  specId?: string;
  request: MemoryRequest;
}

/** A question the agent stopped waiting for (timeout or abort): remove it from the UI. */
export interface WorkerQuestionCancelledMessage {
  type: 'user-question-cancelled';
  taskId: string;
  questionId: string;
}

/** The architect asked the main process to render a .drawio file. */
export interface WorkerRenderDiagramMessage {
  type: 'render-diagram';
  taskId: string;
  requestId: string;
  path: string;
}

/** An agent asked the user something; the worker waits for a 'user-answer'. */
export interface WorkerQuestionMessage {
  type: 'user-question';
  taskId: string;
  projectId?: string;
  data: AgentQuestionRequest;
}

export interface WorkerLogMessage {
  type: 'log';
  taskId: string;
  data: string;
  projectId?: string;
}

export interface WorkerErrorMessage {
  type: 'error';
  taskId: string;
  data: string;
  projectId?: string;
}

export interface WorkerProgressMessage {
  type: 'execution-progress';
  taskId: string;
  data: ExecutionProgressData;
  projectId?: string;
}

export interface WorkerStreamEventMessage {
  type: 'stream-event';
  taskId: string;
  data: StreamEvent;
  projectId?: string;
}

export interface WorkerResultMessage {
  type: 'result';
  taskId: string;
  data: SessionResult;
  projectId?: string;
}

export interface WorkerTaskEventMessage {
  type: 'task-event';
  taskId: string;
  data: Record<string, unknown>;
  projectId?: string;
}

// =============================================================================
// Main → Worker Messages
// =============================================================================

/** Messages sent from main thread to worker */
export type MainToWorkerMessage =
  | { type: 'abort' }
  | { type: 'user-answer'; questionId: string; answers: AgentAnswers | null }
  | {
      type: 'render-result';
      requestId: string;
      ok: boolean;
      pngPath?: string;
      width?: number;
      height?: number;
      error?: string;
    }
  | { type: 'memory-result'; requestId: string; ok: boolean; text?: string; error?: string };

// =============================================================================
// Serialized Security Profile
// =============================================================================

/**
 * Serializable version of SecurityProfile (which uses non-transferable Set objects).
 * Reconstructed into a full SecurityProfile in the worker thread.
 */
export interface SerializedSecurityProfile {
  baseCommands: string[];
  stackCommands: string[];
  scriptCommands: string[];
  customCommands: string[];
  customScripts: {
    shellScripts: string[];
  };
}

// =============================================================================
// Executor Configuration
// =============================================================================

/**
 * Configuration for AgentExecutor.
 */
export interface AgentExecutorConfig {
  /** Task ID for tracking */
  taskId: string;
  /** Project ID for multi-project support */
  projectId?: string;
  /** Process type classification */
  processType: ProcessType;
  /** Session configuration (serializable parts) */
  session: SerializableSessionConfig;
}
