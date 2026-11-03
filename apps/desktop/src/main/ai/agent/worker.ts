/**
 * Worker Thread Entry Point
 * =========================
 *
 * Runs in an isolated worker_thread. Receives configuration via `workerData`,
 * executes Claude Code sessions via `runAgentSession()`, and posts structured messages back to the
 * main thread via `parentPort.postMessage()`.
 *
 * Path handling:
 * - Dev: Loaded directly by electron-vite from source
 * - Production: Bundled into app resources (app.isPackaged)
 */

import { parentPort, workerData } from 'worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { toClaudeAuth } from '../claude-code/auth';
import { setDefaultClaudeAuthProvider } from '../claude-code/default-auth';
import { runAgentSession } from '../claude-code/runner';
import type { AgentAnswers, AskUserHandler } from '../claude-code/user-questions';
import type { MemoryRequest } from './types';
import { buildSubagents, SPEC_SPECIALISTS } from '../claude-code/subagents';
import type { ToolContext } from '../tools/types';
import type { SecurityProfile } from '../security/bash-validator';
import type {
  WorkerConfig,
  WorkerMessage,
  MainToWorkerMessage,
  SerializableSessionConfig,
  WorkerTaskEventMessage,
} from './types';
import type { SessionConfig, StreamEvent, SessionResult } from '../session/types';
import { BuildOrchestrator, type QAPhaseHooks } from '../orchestration/build-orchestrator';
import { DEFAULT_QA_ITERATIONS, QALoop, type QAOutcome } from '../orchestration/qa-loop';
import { resolveBaseRef, runSecurityGates } from '../security/gates';
import { formatFixRequest, isBlocking, runStrix } from '../security/strix';
import { SpecOrchestrator } from '../orchestration/spec-orchestrator';
import type { SpecPhase } from '../orchestration/spec-orchestrator';
import type { AgentType } from '../config/agent-configs';
import type { Phase } from '../config/types';
import type { ExecutionPhase } from '../../../shared/constants/phase-protocol';
import { getPhaseThinking, resolvePhaseModel } from '../config/phase-config';
import { TaskLogWriter } from '../logging/task-log-writer';
import {
  detectProjectCapabilities,
  getQaToolsSection,
  injectContext,
  loadProjectIndex,
  loadProjectInstructions,
  setPromptsDir,
  tryLoadPrompt,
} from '../prompts/prompt-loader';
import type { ProjectCapabilities } from '../prompts/types';
import { runProjectIndexer } from '../project/project-indexer';

// =============================================================================
// Validation
// =============================================================================

if (!parentPort) {
  throw new Error('worker.ts must be run inside a worker_thread');
}

const config = workerData as WorkerConfig;
if (!config?.taskId || !config?.session || !config.promptsDir) {
  throw new Error('worker.ts requires valid WorkerConfig via workerData');
}
setPromptsDir(config.promptsDir);
// Utility tasks in this thread (spec fixer, compactor, insights) use the session's credential
setDefaultClaudeAuthProvider(() =>
  toClaudeAuth(config.session.apiKey, config.session.baseURL, config.session.allowSubscriptionLogin === true),
);

// =============================================================================
// Task Log Writer
// =============================================================================

// Single writer instance for this worker's spec, shared across all sessions
// so that planning/coding/QA phases accumulate into one task_logs.json file.
const logWriter = config.session.specDir
  ? new TaskLogWriter(config.session.specDir, basename(config.session.specDir))
  : null;

// =============================================================================
// Messaging Helpers
// =============================================================================

function postMessage(message: WorkerMessage): void {
  parentPort!.postMessage(message);
}

function postLog(data: string): void {
  postMessage({ type: 'log', taskId: config.taskId, data, projectId: config.projectId });
}

function postError(data: string): void {
  postMessage({ type: 'error', taskId: config.taskId, data, projectId: config.projectId });
}

function postTaskEvent(eventType: string, extra?: Record<string, unknown>): void {
  parentPort?.postMessage({
    type: 'task-event',
    taskId: config.taskId,
    projectId: config.projectId,
    data: {
      type: eventType,
      taskId: config.taskId,
      specId: config.session.specDir ? basename(config.session.specDir) : config.taskId,
      projectId: config.projectId ?? '',
      timestamp: new Date().toISOString(),
      eventId: `${config.taskId}-${eventType}-${Date.now()}`,
      sequence: Date.now(),
      ...extra,
    },
  } satisfies WorkerTaskEventMessage);
}

// =============================================================================
// Abort Handling
// =============================================================================

const abortController = new AbortController();

parentPort.on('message', (msg: MainToWorkerMessage) => {
  if (msg.type === 'abort') {
    abortController.abort();
  } else if (msg.type === 'user-answer') {
    pendingQuestions.get(msg.questionId)?.(msg.answers);
    pendingQuestions.delete(msg.questionId);
  } else if (msg.type === 'render-result') {
    pendingRenders.get(msg.requestId)?.(msg);
  } else if (msg.type === 'memory-result') {
    pendingMemory.get(msg.requestId)?.(msg);
  }
});

// =============================================================================
// Project memory (lives in the main process; asked over the bridge)
// =============================================================================

type MemoryReply = Extract<MainToWorkerMessage, { type: 'memory-result' }>;
const pendingMemory = new Map<string, (reply: MemoryReply) => void>();
const MEMORY_TIMEOUT_MS = 30_000;

/** Ask the main process for memory work. Never rejects: failures come back as { ok: false }. */
function memoryRequest(request: MemoryRequest): Promise<MemoryReply> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const settle = (reply: MemoryReply) => {
      clearTimeout(timer);
      pendingMemory.delete(requestId);
      resolve(reply);
    };
    const timer = setTimeout(() => settle({ type: 'memory-result', requestId, ok: false, error: 'Memory did not answer' }), MEMORY_TIMEOUT_MS);
    pendingMemory.set(requestId, settle);
    postMessage({
      type: 'memory-request',
      taskId: config.taskId,
      requestId,
      specId: config.session.specDir ? basename(config.session.specDir) : undefined,
      request,
    });
  });
}

/** What this task is about, for finding relevant memories: the spec, else the requirements, else the kickoff. */
function taskFocusText(session: SerializableSessionConfig): string {
  for (const name of ['spec.md', 'requirements.json']) {
    try {
      const path = join(session.specDir, name);
      if (session.specDir && existsSync(path)) return readFileSync(path, 'utf-8').slice(0, 1500);
    } catch {
      // try the next source
    }
  }
  const first = session.initialMessages?.[0]?.content;
  return typeof first === 'string' ? first.slice(0, 1500) : '';
}

const memorySections = new Map<string, Promise<string>>();

/** "## Project memory" section for a prompt ('' when memory is off or empty); one lookup per focus. */
function memorySection(session: SerializableSessionConfig, focus?: string): Promise<string> {
  const query = [focus, taskFocusText(session)].filter(Boolean).join('\n');
  const key = focus ?? '';
  let section = memorySections.get(key);
  if (!section) {
    section = query.trim()
      ? memoryRequest({ op: 'prompt', query }).then((reply) => (reply.ok ? reply.text ?? '' : ''))
      : Promise.resolve('');
    memorySections.set(key, section);
  }
  return section;
}

// =============================================================================
// Diagram rendering (architect review loop → main process → PNG)
// =============================================================================

type RenderReply = Extract<MainToWorkerMessage, { type: 'render-result' }>;
const pendingRenders = new Map<string, (reply: RenderReply) => void>();
/** A render that takes longer than this is reported as failed to the architect. */
const RENDER_TIMEOUT_MS = 60_000;

function renderDiagramViaMain(path: string): Promise<{ pngPath: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const settle = (reply: RenderReply) => {
      clearTimeout(timer);
      abortController.signal.removeEventListener('abort', onAbort);
      pendingRenders.delete(requestId);
      if (reply.ok && reply.pngPath) {
        resolve({ pngPath: reply.pngPath, width: reply.width ?? 0, height: reply.height ?? 0 });
      } else {
        reject(new Error(reply.error ?? 'Render failed'));
      }
    };
    const fail = (error: string) => settle({ type: 'render-result', requestId, ok: false, error });
    const onAbort = () => fail('Cancelled');
    const timer = setTimeout(() => fail('Rendering timed out'), RENDER_TIMEOUT_MS);
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    pendingRenders.set(requestId, settle);
    postMessage({ type: 'render-diagram', taskId: config.taskId, requestId, path });
  });
}

// =============================================================================
// Agent questions (Claude Code AskUserQuestion → app UI → back)
// =============================================================================

const pendingQuestions = new Map<string, (answers: AgentAnswers | null) => void>();

/** Ask the user through the main process; resolves null when dismissed or aborted. */
function askUserFor(agentType: AgentType): AskUserHandler {
  return (questions, signal) =>
    new Promise((resolve) => {
      const questionId = randomUUID();
      const finish = (answers: AgentAnswers | null) => {
        signal.removeEventListener('abort', onAbort);
        abortController.signal.removeEventListener('abort', onAbort);
        pendingQuestions.delete(questionId);
        resolve(answers);
      };
      // The agent stopped waiting (hook timeout or abort): take the question off the UI.
      const onAbort = () => {
        if (!pendingQuestions.has(questionId)) return;
        postMessage({ type: 'user-question-cancelled', taskId: config.taskId, questionId });
        finish(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      pendingQuestions.set(questionId, finish);
      postMessage({
        type: 'user-question',
        taskId: config.taskId,
        projectId: config.projectId,
        data: { questionId, agentType, questions },
      });
    });
}

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Reconstruct the SecurityProfile from the serialized form in session config.
 * SecurityProfile uses Set objects that can't cross worker boundaries.
 */
function buildSecurityProfile(session: SerializableSessionConfig): SecurityProfile {
  const serialized = session.toolContext.securityProfile;
  return {
    baseCommands: new Set(serialized?.baseCommands ?? []),
    stackCommands: new Set(serialized?.stackCommands ?? []),
    scriptCommands: new Set(serialized?.scriptCommands ?? []),
    customCommands: new Set(serialized?.customCommands ?? []),
    customScripts: { shellScripts: serialized?.customScripts?.shellScripts ?? [] },
    getAllAllowedCommands() {
      return new Set([
        ...this.baseCommands,
        ...this.stackCommands,
        ...this.scriptCommands,
        ...this.customCommands,
      ]);
    },
  };
}

/**
 * Build a ToolContext for the given session config.
 */
function buildToolContext(session: SerializableSessionConfig, securityProfile: SecurityProfile): ToolContext {
  return {
    cwd: session.toolContext.cwd,
    projectDir: session.toolContext.projectDir,
    specDir: session.toolContext.specDir,
    securityProfile,
    abortSignal: abortController.signal,
    renderDiagram: renderDiagramViaMain,
    searchMemory: async (query, limit) => {
      const reply = await memoryRequest({ op: 'search', query, limit });
      if (!reply.ok) throw new Error(reply.error ?? 'Memory search failed');
      return reply.text ?? '';
    },
    remember: async (memoryType, content, files) => {
      const reply = await memoryRequest({ op: 'remember', memoryType, content, files });
      if (!reply.ok) throw new Error(reply.error ?? 'Could not save the memory');
      return reply.text ?? 'Saved.';
    },
  };
}


/**
 * Load an agent role prompt from the prompts directory the main process
 * resolved for this worker. A missing prompt is a packaging bug: it is logged
 * loudly and the caller falls back to a minimal prompt.
 */
function loadRolePrompt(promptName: string): string | null {
  const prompt = tryLoadPrompt(promptName);
  if (prompt === null) {
    postLog(`ERROR: prompt "${promptName}" not found in ${config.promptsDir}; using a minimal fallback prompt`);
  }
  return prompt;
}


// =============================================================================
// Claude Code session plumbing
// =============================================================================

let cachedCapabilities: ProjectCapabilities | undefined;

/** What kind of app the project is (web frontend, Electron, …), from its project index. */
function projectCapabilities(session: SerializableSessionConfig): ProjectCapabilities {
  cachedCapabilities ??= detectProjectCapabilities(loadProjectIndex(session.projectDir));
  return cachedCapabilities;
}

/** Fields every Claude Code session shares, derived from the worker config. */
function claudeSessionBase(session: SerializableSessionConfig): Pick<
  SessionConfig,
  'auth' | 'mcpOptions' | 'memoryMcpUrl' | 'linearApiKey' | 'bundled'
> {
  return {
    bundled: session.bundled,
    auth: toClaudeAuth(session.apiKey, session.baseURL, session.allowSubscriptionLogin === true),
    mcpOptions: {
      context7Enabled: session.mcpOptions?.context7Enabled ?? true,
      memoryEnabled: session.mcpOptions?.memoryEnabled ?? false,
      linearEnabled: session.mcpOptions?.linearEnabled ?? false,
      electronMcpEnabled: session.mcpOptions?.electronMcpEnabled ?? false,
      browserMcpEnabled: session.mcpOptions?.browserMcpEnabled ?? true,
      projectCapabilities: session.mcpOptions?.projectCapabilities ?? projectCapabilities(session),
      agentMcpAdd: session.mcpOptions?.agentMcpAdd,
      agentMcpRemove: session.mcpOptions?.agentMcpRemove,
    },
    memoryMcpUrl: process.env.GRAPHITI_MCP_URL,
    linearApiKey: process.env.LINEAR_API_KEY,
  };
}

/** Tool output larger than this is summarised before it crosses to the main thread. */
const MAX_RELAYED_RESULT_CHARS = 4000;

/** Keep big tool results (file dumps, base64 images) out of the per-event IPC. */
function compactForRelay(event: StreamEvent): StreamEvent {
  if (event.type !== 'tool-result') return event;
  const text = typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? null);
  if (!text || text.length <= MAX_RELAYED_RESULT_CHARS) return event;
  return { ...event, result: `${text.slice(0, MAX_RELAYED_RESULT_CHARS)}… [${text.length - MAX_RELAYED_RESULT_CHARS} more characters]` };
}

/** Event sink: task_logs.json + live relay to the main thread. */
function relayEvents(phase: Phase) {
  return (event: StreamEvent) => {
    logWriter?.processEvent(event, phase);
    postMessage({
      type: 'stream-event',
      taskId: config.taskId,
      data: compactForRelay(event),
      projectId: config.projectId,
    });
  };
}

// =============================================================================
// Prompt Assembly (provider-agnostic context injection)
// =============================================================================

let cachedProjectInstructions: string | null | undefined;

/**
 * Assemble a full system prompt: the role prompt plus spec location and the
 * project's instructions (AGENTS.md, or CLAUDE.md as a fallback).
 */
async function assemblePrompt(
  promptName: string,
  session: SerializableSessionConfig,
  /** Extra text to find memories for (e.g. the subtask) */
  memoryFocus?: string,
): Promise<string> {
  const basePrompt = loadRolePrompt(promptName)
    ?? buildFallbackPrompt(promptName as AgentType, session.specDir, session.projectDir);

  // Load project instructions once per worker lifetime. CLAUDE.md is loaded by
  // Claude Code itself (settingSources: project), so only AGENTS.md is injected.
  if (cachedProjectInstructions === undefined) {
    const result = await loadProjectInstructions(session.projectDir);
    cachedProjectInstructions = result && !/^claude\.md$/i.test(result.source) ? result.content : null;
    if (result) {
      postLog(`Project instructions loaded from ${result.source} (${(result.content.length / 1024).toFixed(1)}KB)`);
    } else {
      postLog('No project instructions found (checked AGENTS.md, CLAUDE.md)');
    }
  }

  // QA agents get the validation guide for this kind of app (browser, Electron, API, DB).
  const qaTools =
    promptName === 'qa_reviewer' || promptName === 'qa_fixer' ? getQaToolsSection(projectCapabilities(session)) : '';

  const prompt = injectContext(qaTools ? `${basePrompt}\n\n${qaTools}` : basePrompt, {
    specDir: session.specDir,
    projectDir: session.projectDir,
    projectInstructions: cachedProjectInstructions,
  });
  const memory = await memorySection(session, memoryFocus);
  return memory ? `${prompt}\n\n${memory}` : prompt;
}

// =============================================================================
// Single Session Runner
// =============================================================================

/** The model for one phase (see resolvePhaseModel). */
const phaseModel = resolvePhaseModel;

/**
 * Run a single agent session and return the result.
 * Used as the runSession callback for BuildOrchestrator and QALoop.
 */
async function runSingleSession(
  agentType: AgentType,
  phase: Phase,
  systemPrompt: string,
  specDir: string,
  projectDir: string,
  sessionNumber: number,
  subtaskId: string | undefined,
  baseSession: SerializableSessionConfig,
  toolContext: ToolContext,
  initialUserMessage?: string,
  skipPhaseLogging = false,
  outputSchema?: import('zod').ZodSchema,
): Promise<SessionResult> {
  const phaseThinking = await getPhaseThinking(specDir, phase);
  const model = await phaseModel(specDir, phase, baseSession.modelId);
  postLog(`${agentType} on ${model} (${phase})`);

  // Build initial messages: use provided kickoff message, or fall back to session messages
  const initialMessages = initialUserMessage
    ? [{ role: 'user' as const, content: initialUserMessage }]
    : baseSession.initialMessages;

  const sessionConfig: SessionConfig = {
    ...claudeSessionBase(baseSession),
    agentType,
    model,
    systemPrompt,
    initialMessages,
    toolContext,
    maxSteps: baseSession.maxSteps,
    thinkingLevel: phaseThinking as SessionConfig['thinkingLevel'],
    abortSignal: abortController.signal,
    specDir,
    projectDir,
    phase,
    sessionNumber,
    subtaskId,
    outputSchema,
  };

  // Start phase logging for this session (skip when orchestrator manages phases)
  if (logWriter && !skipPhaseLogging) {
    logWriter.startPhase(phase);
  }
  if (logWriter && subtaskId) {
    logWriter.setSubtask(subtaskId);
  }

  let sessionResult: SessionResult;
  try {
    sessionResult = await runAgentSession(sessionConfig, {
      onEvent: relayEvents(phase),
      askUser: askUserFor(sessionConfig.agentType),
      onLog: postLog,
    });
  } catch (error) {
    // Ensure log cleanup happens on failure
    if (logWriter && !skipPhaseLogging) logWriter.endPhase(phase, false);
    if (logWriter) logWriter.setSubtask(undefined);
    throw error;
  }

  // End phase logging — mark as completed or failed based on outcome (skip when orchestrator manages phases)
  if (logWriter && !skipPhaseLogging) {
    const success = sessionResult.outcome === 'completed' || sessionResult.outcome === 'max_steps';
    logWriter.endPhase(phase, success);
  }
  if (logWriter) {
    logWriter.setSubtask(undefined);
  }

  return sessionResult;
}

// =============================================================================
// Session Execution
// =============================================================================

async function run(): Promise<void> {
  const { session } = config;

  postLog(`Starting agent session: type=${session.agentType}, model=${session.modelId}`);

  try {
    const securityProfile = buildSecurityProfile(session);
    const toolContext = buildToolContext(session, securityProfile);
    // Route to orchestrator for build_orchestrator agent type
    if (session.agentType === 'build_orchestrator') {
      await runBuildOrchestrator(session, toolContext);
      return;
    }

    // Route to QA loop for qa_reviewer agent type
    if (session.agentType === 'qa_reviewer') {
      await runQALoop(session, toolContext);
      return;
    }

    // Route to spec orchestrator for spec_orchestrator agent type
    if (session.agentType === 'spec_orchestrator') {
      if (session.useAgenticOrchestration) {
        await runAgenticSpecOrchestrator(session, toolContext);
      } else {
        await runSpecOrchestrator(session, toolContext);
      }
      return;
    }

    // Default: single session for all other agent types
    await runDefaultSession(session, toolContext);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    postError(`Agent session failed: ${message}`);
  }
}

/**
 * Run a single agent session (default path for spec_orchestrator, etc.)
 */
async function runDefaultSession(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
): Promise<void> {
  const sessionConfig: SessionConfig = {
    ...claudeSessionBase(session),
    agentType: session.agentType,
    model: session.modelId,
    systemPrompt: session.systemPrompt,
    initialMessages: session.initialMessages,
    toolContext,
    maxSteps: session.maxSteps,
    thinkingLevel: session.thinkingLevel,
    abortSignal: abortController.signal,
    specDir: session.specDir,
    projectDir: session.projectDir,
    phase: session.phase,
    modelShorthand: session.modelShorthand,
    sessionNumber: session.sessionNumber,
    subtaskId: session.subtaskId,
  };

  // Start phase logging for default session
  const defaultPhase: Phase = session.phase ?? 'coding';
  if (logWriter) {
    logWriter.startPhase(defaultPhase);
  }

  let result: SessionResult | undefined;
  try {
    result = await runAgentSession(sessionConfig, {
      onEvent: relayEvents(defaultPhase),
      askUser: askUserFor(sessionConfig.agentType),
      onLog: postLog,
    });
  } finally {
    if (logWriter) {
      const success = result?.outcome === 'completed' || result?.outcome === 'max_steps';
      logWriter.endPhase(defaultPhase, success ?? false);
    }
  }

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result as SessionResult,
    projectId: config.projectId,
  });
}

/** Map ExecutionPhase to Phase for log writer. Returns undefined for non-loggable phases. */
function mapExecutionPhaseToPhase(executionPhase: ExecutionPhase): Phase | undefined {
  switch (executionPhase) {
    case 'planning': return 'planning';
    case 'coding': return 'coding';
    case 'qa_review': return 'qa';
    case 'qa_fixing': return 'qa';
    default: return undefined; // idle, complete, failed, pause states
  }
}

/**
 * Run the full build orchestration pipeline:
 * planning → coding (per subtask) → QA review → QA fixing
 */
async function runBuildOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
): Promise<void> {
  postLog('Starting BuildOrchestrator pipeline (planning → coding → QA)');

  const orchestrator = new BuildOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    sourceSpecDir: session.sourceSpecDir,
    abortSignal: abortController.signal,

    // What each coder session learned goes to the project's memory
    insightModel: await phaseModel(session.specDir, 'coding', session.modelId),
    onInsights: (_subtask, insights) => {
      void memoryRequest({ op: 'insights', insights }).then((reply) => {
        const count = Number(reply.text ?? 0);
        if (reply.ok && count > 0) postLog(`Saved ${count} memor${count === 1 ? 'y' : 'ies'} from subtask ${insights.subtask_id}`);
      });
    },

    generatePrompt: async (agentType, _phase, context) => {
      const promptName = agentType === 'coder' ? 'coder' : agentType;
      let prompt = await assemblePrompt(promptName, session, context.subtask?.description);

      // Inject schema validation error feedback on retry so the planner knows what to fix
      if (context.planningRetryContext) {
        prompt += `\n\n${context.planningRetryContext}`;
      }

      return prompt;
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (phase=${runConfig.phase}, session=${runConfig.sessionNumber})`);
      // The architect documents; it writes only inside the spec directory.
      const sessionToolContext: ToolContext =
        runConfig.agentType === 'architect'
          ? { ...toolContext, allowedWritePaths: [runConfig.specDir] }
          : toolContext;
      // Build a kickoff message for the agent so it has a task to act on
      const kickoffMessage = buildKickoffMessage(runConfig.agentType, runConfig.specDir, runConfig.projectDir);
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        runConfig.subtaskId,
        session,
        sessionToolContext,
        kickoffMessage,
        true, // skipPhaseLogging — orchestrator manages phase start/end
        runConfig.outputSchema,
      );
    },

    runQA: (hooks) => runQualityAssurance(session, toolContext, hooks),
  });

  orchestrator.on('phase-change', (phase: ExecutionPhase, message: string) => {
    postLog(`Phase: ${phase} — ${message}`);
    // Start the phase in the log writer at orchestrator level (not per-session)
    const logPhase = mapExecutionPhaseToPhase(phase);
    if (logWriter && logPhase) {
      logWriter.startPhase(logPhase, message);
    }
    // Emit XState-compatible task events for phase transitions
    // so the state machine tracks the build lifecycle correctly.
    if (phase === 'coding') {
      postTaskEvent('CODING_STARTED', { subtaskId: '', subtaskDescription: 'Starting coding phase' });
    } else if (phase === 'qa_review') {
      postTaskEvent('QA_STARTED', { iteration: 0, maxIterations: DEFAULT_QA_ITERATIONS });
    } else if (phase === 'qa_fixing') {
      postTaskEvent('QA_FIXING_STARTED', { iteration: 0 });
    }
    // Emit execution-progress so the main thread can:
    // 1. Re-point the file watcher to the worktree spec dir
    // 2. Update the UI with phase progress
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase,
        phaseProgress: 0,
        overallProgress: 0,
        message,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('iteration-start', (iteration: number, phase: ExecutionPhase) => {
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase,
        phaseProgress: 0,
        overallProgress: 0,
        message: `Iteration ${iteration} (${phase})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('session-complete', (_result: SessionResult, phase: string) => {
    // Notify the main process that a session (subtask) completed.
    // This triggers persistPlanPhaseSync → invalidateTasksCache so the frontend
    // sees updated subtask statuses in the implementation plan.
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: phase as ExecutionPhase,
        phaseProgress: 0,
        overallProgress: 0,
        message: `Session complete (${phase})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('log', (message: string) => {
    postLog(message);
  });

  orchestrator.on('error', (error: Error, phase: string) => {
    postLog(`Error in ${phase} phase: ${error.message}`);
  });

  const outcome = await orchestrator.run();

  // End the final phase and flush any remaining accumulated log entries.
  // When the orchestrator reaches 'complete' or 'failed', finalPhase is a terminal
  // state that doesn't map to a log phase. In that case, close whichever log phase
  // is still marked 'active' so the UI shows "Complete" instead of "Running".
  if (logWriter) {
    const finalLogPhase = mapExecutionPhaseToPhase(outcome.finalPhase);
    if (finalLogPhase) {
      logWriter.endPhase(finalLogPhase, outcome.success);
    } else {
      // Terminal state (complete/failed) — close any still-active log phase
      const data = logWriter.getData();
      for (const phase of ['validation', 'coding', 'planning'] as const) {
        if (data.phases[phase]?.status === 'active') {
          const mapped = phase === 'validation' ? 'qa' : phase;
          logWriter.endPhase(mapped as 'qa' | 'coding' | 'planning', outcome.success);
          break;
        }
      }
    }
    logWriter.flush();
  }

  // Emit task events based on orchestration outcome so XState machine
  // can transition to the correct state (e.g., human_review on success).
  if (outcome.success) {
    postTaskEvent('QA_PASSED');
    postTaskEvent('BUILD_COMPLETE');
  } else if (outcome.codingCompleted) {
    // Coding succeeded but QA failed — emit QA-specific event so XState
    // transitions to 'error' with reviewReason='errors' instead of the
    // generic CODING_FAILED which would be misleading.
    postTaskEvent('QA_MAX_ITERATIONS', {
      iteration: outcome.totalIterations,
      maxIterations: DEFAULT_QA_ITERATIONS,
    });
  } else {
    // Pre-QA failure (planning or coding phase)
    postTaskEvent('CODING_FAILED', { error: outcome.error });
  }

  postFinalResult(outcome.success, outcome.totalIterations, outcome.durationMs, outcome.error);
}

/**
 * QA for a finished build: security gates → reviewer ⇄ fixer (QALoop), then
 * the optional Strix Security QA. Shared by the build pipeline and by a
 * re-review after human feedback. Returns the outcome; posts nothing.
 */
async function runQualityAssurance(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  hooks?: QAPhaseHooks,
): Promise<QAOutcome> {
  const qaLoop = new QALoop({
    specDir: session.specDir,
    projectDir: session.projectDir,
    abortSignal: abortController.signal,
    maxIterations: DEFAULT_QA_ITERATIONS,

    runGates: () =>
      runSecurityGates({
        projectDir: session.projectDir,
        specDir: session.specDir,
        gitleaksBin: session.bundled?.gitleaksBin,
        osvScannerBin: session.bundled?.osvScannerBin,
        signal: abortController.signal,
      }),

    generatePrompt: (agentType) => assemblePrompt(agentType === 'qa_fixer' ? 'qa_fixer' : 'qa_reviewer', session),

    runSession: (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (session=${runConfig.sessionNumber})`);
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        undefined,
        session,
        toolContext,
        buildKickoffMessage(runConfig.agentType, runConfig.specDir, runConfig.projectDir),
        true, // skipPhaseLogging — the caller manages QA phase logging
      );
    },
  });

  qaLoop.on('log', (message: string) => postLog(message));
  if (hooks) {
    qaLoop.on('qa-iteration-start', hooks.onReview);
    qaLoop.on('qa-fix-start', hooks.onFix);
  }

  const outcome = await qaLoop.run();
  return outcome.approved && session.securityQa?.enabled ? runSecurityQa(session, qaLoop, outcome) : outcome;
}

/** The final result message every pipeline sends back to the bridge. */
function postFinalResult(success: boolean, steps: number, durationMs: number, error?: string): void {
  const result: SessionResult = {
    outcome: success ? 'completed' : 'error',
    stepsExecuted: steps,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs,
    error: error ? { code: 'generic_error', message: error, retryable: false } : undefined,
  };
  postMessage({ type: 'result', taskId: config.taskId, data: result, projectId: config.projectId });
}

/**
 * Re-run QA on an existing build (e.g. after the user rejected it in review).
 */
async function runQALoop(session: SerializableSessionConfig, toolContext: ToolContext): Promise<void> {
  postLog('Starting QA validation loop');
  logWriter?.startPhase('qa');

  const outcome = await runQualityAssurance(session, toolContext);

  if (logWriter) {
    logWriter.endPhase('qa', outcome.approved);
    logWriter.flush();
  }

  if (outcome.approved) {
    postTaskEvent('QA_PASSED');
  } else if (outcome.reason === 'max_iterations' || outcome.reason === 'security_findings') {
    // Both go to human review with the reports attached.
    postTaskEvent('QA_MAX_ITERATIONS');
  } else {
    postTaskEvent('QA_AGENT_ERROR', { error: outcome.error });
  }

  postFinalResult(outcome.approved, outcome.totalIterations, outcome.durationMs, outcome.error);
}

/** Strix rounds before unresolved findings go to human review. */
const MAX_SECURITY_QA_ROUNDS = 2;

/**
 * Security QA after QA approval: Strix pentests the changed code; blocking
 * findings go to the QA fixer (as a fix request) and QA re-reviews. Skipped
 * or failed scans never block the task — the reason is logged and written
 * to security_qa.md.
 */
async function runSecurityQa(
  session: SerializableSessionConfig,
  qaLoop: QALoop,
  approved: QAOutcome,
): Promise<QAOutcome> {
  const settings = session.securityQa!;
  let outcome = approved;
  const diffBase = await resolveBaseRef(session.projectDir);

  for (let round = 1; round <= MAX_SECURITY_QA_ROUNDS; round++) {
    const result = await runStrix({
      projectDir: session.projectDir,
      specDir: session.specDir,
      settings,
      // Strix tests what QA approved, on the task's QA model
      model: await phaseModel(session.specDir, 'qa', session.modelId),
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      diffBase,
      signal: abortController.signal,
      onLog: postLog,
    });

    if (result.status === 'cancelled') return { ...outcome, approved: false, reason: 'cancelled' };
    if (result.status !== 'findings') {
      postLog(
        result.status === 'clear'
          ? 'Security QA: no exploitable findings'
          : `Security QA ${result.status}: ${result.reason ?? 'see security_qa.md'}`,
      );
      return outcome;
    }

    const blocking = result.findings.filter((f) => isBlocking(f, settings.failOn));
    postLog(`Security QA: ${blocking.length} finding(s) at ${settings.failOn} or above (round ${round}/${MAX_SECURITY_QA_ROUNDS})`);
    if (round === MAX_SECURITY_QA_ROUNDS) {
      return { ...outcome, approved: false, reason: 'security_findings', error: 'Security QA findings remain; see security_qa.md' };
    }

    // Hand the findings to the fixer through the human-feedback path, then re-review.
    await writeFile(join(session.specDir, 'QA_FIX_REQUEST.md'), formatFixRequest(result, settings, session.specDir), 'utf-8');
    outcome = await qaLoop.run();
    if (!outcome.approved) return outcome;
  }
  return outcome;
}

/**
 * Run the spec creation orchestration pipeline with complexity-based phase routing.
 */
async function runSpecOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
): Promise<void> {
  // Extract the task description from the first user message
  const taskDescription = session.initialMessages?.[0]?.content
    ? typeof session.initialMessages[0].content === 'string'
      ? session.initialMessages[0].content
      : 'Create the specification as described in your system prompt.'
    : 'Create the specification as described in your system prompt.';

  postLog(`Starting SpecOrchestrator pipeline (complexity-first phase routing)`);

  // Generate project index BEFORE any agent runs — gives all phases project context
  let projectIndexContent: string | undefined;
  try {
    const indexOutputPath = join(session.specDir, 'project_index.json');
    postLog('Generating project index...');
    runProjectIndexer(session.projectDir, indexOutputPath);
    projectIndexContent = readFileSync(indexOutputPath, 'utf-8');
    postLog(`Project index generated (${(projectIndexContent.length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    postLog(`Project index generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  const orchestrator = new SpecOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    taskDescription,
    projectIndex: projectIndexContent,
    abortSignal: abortController.signal,

    generatePrompt: async (_agentType, phase, context) => {
      const promptName = specPhaseToPromptName(phase);
      let prompt = await assemblePrompt(promptName, session);

      // Inject schema validation error feedback on retry so the agent knows what to fix
      if (context.schemaRetryContext) {
        prompt += `\n\n${context.schemaRetryContext}`;
      }

      return prompt;
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (spec phase=${runConfig.specPhase ?? runConfig.phase}, session=${runConfig.sessionNumber})`);
      const kickoffMessage = buildSpecKickoffMessage(
        runConfig.agentType,
        runConfig.specDir,
        runConfig.projectDir,
        taskDescription,
        runConfig.priorPhaseOutputs,
        runConfig.projectIndex,
        runConfig.specPhase,
      );
      // Spec agents can only write to the spec directory
      const specToolContext: ToolContext = {
        ...toolContext,
        allowedWritePaths: [session.specDir],
      };
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        undefined,
        session,
        specToolContext,
        kickoffMessage,
        true, // skipPhaseLogging — orchestrator manages phase start/end
        runConfig.outputSchema,
      );
    },
  });

  // Wire event listeners
  orchestrator.on('phase-start', (phase: SpecPhase, phaseNumber: number, totalPhases: number) => {
    postLog(`Spec phase ${phaseNumber}/${totalPhases}: ${phase}`);
    if (logWriter) {
      logWriter.startPhase('spec', `${phase} (${phaseNumber}/${totalPhases})`);
    }
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: 'planning', // spec creation maps to 'planning' in the UI execution phases
        phaseProgress: phaseNumber / Math.max(totalPhases, 1),
        overallProgress: phaseNumber / Math.max(totalPhases, 1),
        message: `Spec creation: ${phase} (${phaseNumber}/${totalPhases})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('phase-complete', (_phase: SpecPhase, _result: unknown) => {
    // End the current spec log phase so the next one can start fresh
    if (logWriter) {
      logWriter.endPhase('spec', true);
    }
  });

  orchestrator.on('log', (message: string) => {
    postLog(message);
  });

  orchestrator.on('error', (error: Error, phase: SpecPhase) => {
    postLog(`Error in spec ${phase} phase: ${error.message}`);
  });

  const outcome = await orchestrator.run();

  // Emit task event on failure so XState gets a specific signal
  // instead of relying on the generic PROCESS_EXITED fallback.
  if (!outcome.success) {
    postTaskEvent('PLANNING_FAILED', { error: outcome.error });
  }

  // Ensure any still-active log phase is closed and flushed
  if (logWriter) {
    const data = logWriter.getData();
    // toLogPhase('spec') maps to 'planning' in the log writer
    if (data.phases.planning?.status === 'active') {
      logWriter.endPhase('spec', outcome.success);
    }
    logWriter.flush();
  }

  // Map outcome to SessionResult for the worker bridge
  const result: SessionResult = {
    outcome: outcome.success ? 'completed' : 'error',
    stepsExecuted: outcome.phasesExecuted.length,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the spec creation pipeline using agentic orchestration.
 * Instead of procedural phase routing, an AI orchestrator agent drives the
 * entire pipeline using tools (including SpawnSubagent for specialist work).
 */
async function runAgenticSpecOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
): Promise<void> {
  // Extract task description
  const taskDescription = session.initialMessages?.[0]?.content
    ? typeof session.initialMessages[0].content === 'string'
      ? session.initialMessages[0].content
      : 'Create the specification as described in your system prompt.'
    : 'Create the specification as described in your system prompt.';

  postLog('Starting Agentic SpecOrchestrator (AI-driven pipeline via SpawnSubagent)');

  // Generate project index
  let projectIndexContent: string | undefined;
  try {
    const indexOutputPath = join(session.specDir, 'project_index.json');
    postLog('Generating project index...');
    runProjectIndexer(session.projectDir, indexOutputPath);
    projectIndexContent = readFileSync(indexOutputPath, 'utf-8');
    postLog(`Project index generated (${(projectIndexContent.length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    postLog(`Project index generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  // Spec specialists become Claude Code subagents (delegated via the Agent tool)
  const agents = await buildSubagents(SPEC_SPECIALISTS, (promptName) => assemblePrompt(promptName, session));
  postLog(`Registered ${Object.keys(agents).length} spec subagents`);

  const orchestratorToolContext: ToolContext = {
    ...toolContext,
    allowedWritePaths: [session.specDir],
  };

  // Load the agentic orchestrator prompt
  const systemPrompt = await assemblePrompt('spec_orchestrator_agentic', session);

  // Build the kickoff message
  const kickoffParts = [
    `Create a complete specification for the following task:\n\n${taskDescription}\n`,
    `\nSpec directory: ${session.specDir}`,
    `\nProject directory: ${session.projectDir}`,
  ];

  if (projectIndexContent) {
    kickoffParts.push(`\n\n## PROJECT INDEX\n\n\`\`\`json\n${projectIndexContent}\n\`\`\``);
  }

  const kickoffMessage = kickoffParts.join('');

  const phaseThinking = await getPhaseThinking(session.specDir, 'spec');

  const sessionConfig: SessionConfig = {
    ...claudeSessionBase(session),
    agentType: 'spec_orchestrator',
    model: await phaseModel(session.specDir, 'spec', session.modelId),
    agents,
    systemPrompt,
    initialMessages: [{ role: 'user' as const, content: kickoffMessage }],
    toolContext: orchestratorToolContext,
    maxSteps: session.maxSteps,
    thinkingLevel: phaseThinking as SessionConfig['thinkingLevel'],
    abortSignal: abortController.signal,
    specDir: session.specDir,
    projectDir: session.projectDir,
    phase: 'spec',
    sessionNumber: 1,
  };

  // Start phase logging
  if (logWriter) {
    logWriter.startPhase('spec', 'Agentic spec orchestration');
  }

  let result: SessionResult | undefined;
  try {
    result = await runAgentSession(sessionConfig, {
      onEvent: relayEvents('spec'),
      askUser: askUserFor(sessionConfig.agentType),
      onLog: postLog,
    });
  } finally {
    if (logWriter) {
      const success = result?.outcome === 'completed' || result?.outcome === 'max_steps';
      logWriter.endPhase('spec', success ?? false);
      logWriter.flush();
    }
  }

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result as SessionResult,
    projectId: config.projectId,
  });
}

/**
 * Map a SpecPhase to the prompt file name to load.
 * Falls back to the closest available prompt when a phase-specific one doesn't exist.
 */
function specPhaseToPromptName(phase: SpecPhase): string {
  switch (phase) {
    case 'discovery': return 'spec_gatherer';
    case 'requirements': return 'spec_gatherer';
    case 'complexity_assessment': return 'complexity_assessor';
    case 'research': return 'spec_researcher';
    case 'context': return 'spec_writer';
    case 'historical_context': return 'spec_writer';
    case 'spec_writing': return 'spec_writer';
    case 'self_critique': return 'spec_critic';
    case 'architecture': return 'architect';
    case 'planning': return 'planner';
    case 'quick_spec': return 'spec_quick';
    case 'validation': return 'spec_writer';
    default: return 'spec_writer';
  }
}

/**
 * Build a kickoff user message for a spec phase session.
 * Includes accumulated context from prior phases to eliminate redundant file reads.
 */
function buildSpecKickoffMessage(
  agentType: AgentType,
  specDir: string,
  projectDir: string,
  taskDescription: string,
  priorPhaseOutputs?: Record<string, string>,
  projectIndex?: string,
  specPhase?: string,
): string {
  // Build the base task-specific message
  let baseMessage: string;

  // Spec phase takes priority over agentType for kickoff routing
  // (e.g., complexity_assessment uses spec_gatherer agentType but needs a different kickoff)
  if (specPhase === 'complexity_assessment') {
    baseMessage = `Assess the complexity of the following task and write your assessment to ${specDir}/complexity_assessment.json. Task: ${taskDescription}. Project root: ${projectDir}. Determine if this is a SIMPLE, STANDARD, or COMPLEX task based on the scope of changes required.\n\nIMPORTANT: This is the FIRST phase of the spec pipeline. No spec.md or other spec files exist yet — do NOT attempt to read them. Assess complexity based on the task description and the project structure at ${projectDir} only.`;
  } else switch (agentType) {
    case 'spec_discovery':
      baseMessage = `Analyze the project structure at ${projectDir} to understand the codebase architecture, tech stack, and conventions. Write your findings to ${specDir}/context.json. Task context: ${taskDescription}\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Analyze the project source code at ${projectDir} directly.`;
      break;
    case 'spec_gatherer':
      baseMessage = `Gather and validate requirements for the following task: ${taskDescription}. Project root: ${projectDir}. Write requirements to ${specDir}/requirements.json.\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Derive requirements from the task description and the project source code at ${projectDir}.`;
      break;
    case 'spec_researcher':
      baseMessage = `Research implementation approaches for: ${taskDescription}. Review relevant code in ${projectDir} and document your findings in ${specDir}/research.json.`;
      break;
    case 'spec_writer':
      baseMessage = `Write the specification for: ${taskDescription}. Write spec.md to ${specDir}. Project root: ${projectDir}.`;
      break;
    case 'architect':
      baseMessage = `Design the architecture for: ${taskDescription}. Read the spec at ${specDir}/spec.md and the project at ${projectDir}, then write ${specDir}/architecture/architecture.md, ADRs under ${specDir}/architecture/adr/ and draw.io diagrams under ${specDir}/architecture/diagrams/, rendering each diagram with render_diagram and fixing layout problems before you finish.`;
      break;
    case 'planner':
      baseMessage = `Create a detailed implementation plan for: ${taskDescription}. Read the spec at ${specDir}/spec.md (and ${specDir}/architecture/ when it exists) and create ${specDir}/implementation_plan.json with concrete coding subtasks. Project root: ${projectDir}.`;
      break;
    case 'spec_critic':
      baseMessage = `Review and critique the specification at ${specDir}/spec.md for completeness, clarity, and technical feasibility. Write your critique findings back to ${specDir}/spec.md with improvements.`;
      break;
    case 'spec_context':
      baseMessage = `Gather project context relevant to: ${taskDescription}. Analyze the codebase at ${projectDir} and write context to ${specDir}/context.json.\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Analyze the project source code at ${projectDir} directly.`;
      break;
    case 'spec_validation':
      baseMessage = `Validate that ${specDir}/spec.md and ${specDir}/implementation_plan.json are complete, consistent, and ready for implementation. Fix any issues found.`;
      break;
    default:
      baseMessage = `Complete the spec creation task described in your system prompt. Task: ${taskDescription}. Spec directory: ${specDir}. Project directory: ${projectDir}`;
  }

  // Inject accumulated context from prior phases
  const contextSections: string[] = [baseMessage];

  if (projectIndex) {
    contextSections.push(`\n\n## PROJECT INDEX (pre-generated)\n\nThe following project structure analysis has been pre-generated for you. Use this as your starting point instead of scanning the entire project:\n\n\`\`\`json\n${projectIndex}\n\`\`\``);
  }

  if (priorPhaseOutputs && Object.keys(priorPhaseOutputs).length > 0) {
    contextSections.push('\n\n## CONTEXT FROM PRIOR PHASES\n\nThe following outputs from earlier spec phases are provided to avoid re-reading files:');
    for (const [fileName, content] of Object.entries(priorPhaseOutputs)) {
      const ext = fileName.endsWith('.json') ? 'json' : 'markdown';
      contextSections.push(`\n### ${fileName}\n\n\`\`\`${ext}\n${content}\n\`\`\``);
    }
    contextSections.push('\nUse these outputs as your primary source of context. Only read additional project files if you need specific code patterns not covered above.');
  }

  return contextSections.join('');
}

/**
 * Build a kickoff user message for an agent session.
 * The AI SDK requires at least one user message; this provides a concrete task directive.
 */
function buildKickoffMessage(agentType: AgentType, specDir: string, projectDir: string): string {
  switch (agentType) {
    case 'planner':
      return `Read the spec at ${specDir}/spec.md and create a detailed implementation plan at ${specDir}/implementation_plan.json. Project root: ${projectDir}`;
    case 'architect':
      return `Read the spec at ${specDir}/spec.md and the project at ${projectDir}, then design the architecture: write ${specDir}/architecture/architecture.md, ADRs under ${specDir}/architecture/adr/ and draw.io diagrams under ${specDir}/architecture/diagrams/, rendering each diagram with render_diagram and fixing layout problems before you finish.`;
    case 'coder':
      return `Read ${specDir}/implementation_plan.json and implement the next pending subtask. Project root: ${projectDir}. After completing the subtask, update its status to "completed" in implementation_plan.json.`;
    case 'qa_reviewer':
      return `Review the implementation in ${projectDir} against the specification in ${specDir}/spec.md. Write your findings to ${specDir}/qa_report.md with a clear "Status: PASSED" or "Status: FAILED" line.`;
    case 'qa_fixer':
      return `Read ${specDir}/qa_report.md for the issues found by QA review. Fix all issues in ${projectDir}. After fixing, update ${specDir}/qa_report.md to indicate fixes have been applied.`;
    default:
      return `Complete the task described in your system prompt. Spec directory: ${specDir}. Project directory: ${projectDir}`;
  }
}

/**
 * Build a minimal fallback prompt when the prompts directory is not found.
 */
function buildFallbackPrompt(agentType: AgentType, specDir: string, projectDir: string): string {
  switch (agentType) {
    case 'planner':
      return `You are a planning agent. Read spec.md in ${specDir} and create implementation_plan.json with phases and subtasks. Each subtask must have id, description, and status fields. Set all statuses to "pending".`;
    case 'architect':
      return `You are a software architect. Read spec.md in ${specDir} and the codebase at ${projectDir}. Write ${specDir}/architecture/architecture.md (context, containers, key decisions, constraints for the planner) and ADRs under ${specDir}/architecture/adr/. Write only inside ${specDir}/architecture/.`;
    case 'coder':
      return `You are a coding agent. Implement the current pending subtask from implementation_plan.json in ${specDir}. Project root: ${projectDir}. After completing the subtask, update its status to "completed" in implementation_plan.json.`;
    case 'qa_reviewer':
      return `You are a QA reviewer. Review the implementation in ${projectDir} against the spec in ${specDir}/spec.md. Write your findings to ${specDir}/qa_report.md with "Status: PASSED" or "Status: FAILED".`;
    case 'qa_fixer':
      return `You are a QA fixer. Read ${specDir}/qa_report.md for the issues found by QA review. Fix the issues in ${projectDir}. After fixing, update ${specDir}/implementation_plan.json qa_signoff status to "fixes_applied".`;
    default:
      return `You are an AI agent. Complete the task described in ${specDir}/spec.md for the project at ${projectDir}.`;
  }
}

// Start execution
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  postError(`Unhandled worker error: ${message}`);
});
