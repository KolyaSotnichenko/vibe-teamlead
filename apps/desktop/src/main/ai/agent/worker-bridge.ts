/**
 * Worker Bridge
 * =============
 *
 * Main-thread bridge that spawns a Worker thread and relays `postMessage()`
 * events to an EventEmitter matching the `AgentManagerEvents` interface.
 *
 * This allows the existing agent management system (agent-process.ts,
 * agent-events.ts) to consume worker thread events transparently — the UI
 * cannot distinguish between a Python subprocess and a TS worker thread.
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { app } from 'electron';

import type { AgentManagerEvents, ExecutionProgressData, ProcessType } from '../../agent/types';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import type {
  WorkerConfig,
  WorkerMessage,
  AgentExecutorConfig,
  MainToWorkerMessage,
} from './types';
import type { SessionResult } from '../session/types';
import { ProgressTracker } from '../session/progress-tracker';
import { resolveBundledTools } from '../claude-code/bundled-tools';
import { isSubscriptionModeEnabled } from '../claude-code/subscription-setting';
import { readStrixSettings } from '../security/strix-setting';
import { resolvePromptsDir } from '../prompts/prompt-loader';
import type { AgentAnswers } from '../claude-code/user-questions';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** How long a stopping worker gets to abort cleanly before it is terminated. */
const TERMINATE_GRACE_MS = 5000;
/** Emit buffered agent text once it grows past this without a newline. */
const TEXT_FLUSH_CHARS = 2000;

// =============================================================================
// Worker Path Resolution
// =============================================================================

/**
 * Resolve the path to the worker entry point.
 * Handles both dev (source via electron-vite) and production (bundled) paths.
 */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    // Production: worker is inside app.asar at out/main/ai/agent/worker.js
    return path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'ai', 'agent', 'worker.js');
  }
  // Dev: electron-vite outputs worker at out/main/ai/agent/worker.js
  // because the Rollup input key is 'ai/agent/worker'.
  // __dirname resolves to out/main/ at runtime, so we need the subdirectory.
  return path.join(__dirname, 'ai', 'agent', 'worker.js');
}

// =============================================================================
// WorkerBridge
// =============================================================================

/**
 * Bridges a worker thread to the AgentManagerEvents interface.
 *
 * Usage:
 * ```ts
 * const bridge = new WorkerBridge();
 * bridge.on('log', (taskId, log) => { ... });
 * bridge.on('exit', (taskId, code, processType) => { ... });
 * await bridge.spawn(config);
 * ```
 */
export class WorkerBridge extends EventEmitter {
  private worker: Worker | null = null;
  private progressTracker: ProgressTracker = new ProgressTracker();
  private taskId: string = '';
  private projectId: string | undefined;
  private processType: ProcessType = 'task-execution';
  private viewerScript: string | undefined;
  private finished = false;
  private lastProgressKey = '';
  private textBuffer = '';

  /**
   * Spawn a worker thread with the given configuration.
   * The worker will immediately begin executing the agent session.
   *
   * @param config - Executor configuration (task ID, session params, etc.)
   */
  spawn(config: AgentExecutorConfig): void {
    if (this.worker) {
      throw new Error('WorkerBridge already has an active worker. Call terminate() first.');
    }

    this.taskId = config.taskId;
    this.projectId = config.projectId;
    this.processType = config.processType;
    this.progressTracker = new ProgressTracker();
    this.finished = false;
    this.lastProgressKey = '';
    this.textBuffer = '';

    const bundled = config.session.bundled ?? resolveBundledTools();
    this.viewerScript = bundled.drawioViewerScript;

    const workerConfig: WorkerConfig = {
      taskId: config.taskId,
      projectId: config.projectId,
      processType: config.processType,
      session: {
        ...config.session,
        bundled,
        allowSubscriptionLogin: config.session.allowSubscriptionLogin ?? isSubscriptionModeEnabled(),
        securityQa: config.session.securityQa ?? readStrixSettings(),
      },
      promptsDir: resolvePromptsDir(),
    };

    const workerPath = resolveWorkerPath();

    this.worker = new Worker(workerPath, {
      workerData: workerConfig,
    });

    this.worker.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(message);
    });

    this.worker.on('error', (error: Error) => {
      // An uncaught exception in the worker: report it and end the task (the
      // following 'exit' event is then ignored).
      this.emitTyped('error', this.taskId, error.message, this.projectId);
      this.finish(1);
    });

    this.worker.on('exit', (code: number) => {
      this.finish(code === 0 ? 0 : code);
    });
  }

  /**
   * Stop the task: ask the worker to abort (so the SDK can shut down Claude
   * Code and its MCP servers), wait up to the grace period, then force it.
   * Does not emit 'exit' — the caller owns the stopped task's state.
   */
  async terminate(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.finished = true;
    this.cleanup();

    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    try {
      worker.postMessage({ type: 'abort' });
    } catch {
      // Worker may already be dead
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), TERMINATE_GRACE_MS).unref?.()),
    ]);
    if (timedOut) {
      try {
        await worker.terminate();
      } catch {
        // Already terminated
      }
    }
  }

  /** Emit 'exit' exactly once and release the worker thread. */
  private finish(exitCode: number): void {
    if (this.finished) return;
    this.finished = true;
    this.flushText();
    const worker = this.worker;
    this.cleanup();
    this.emitTyped('exit', this.taskId, exitCode, this.processType, this.projectId);
    void worker?.terminate().catch(() => {});
  }

  /** Whether the worker is currently active */
  get isActive(): boolean {
    return this.worker !== null;
  }

  /** Get the underlying Worker instance (for advanced use) */
  get workerInstance(): Worker | null {
    return this.worker;
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleWorkerMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'log':
        this.emitTyped('log', message.taskId, message.data, message.projectId);
        break;

      case 'error':
        this.emitTyped('error', message.taskId, message.data, message.projectId);
        break;

      case 'execution-progress':
        this.emitTyped('execution-progress', message.taskId, message.data, message.projectId);
        break;

      case 'stream-event':
        // Feed the progress tracker; progress is emitted only when it changes.
        this.progressTracker.processEvent(message.data);
        this.emitProgressFromTracker(message.taskId, message.projectId);
        // Agent text goes to the log line by line, not per token.
        if (message.data.type === 'text-delta') {
          this.bufferText(message.data.text);
        } else if (message.data.type === 'step-finish') {
          this.flushText();
        }
        break;

      case 'task-event':
        this.emitTyped('task-event', message.taskId, message.data as TaskEventPayload, message.projectId);
        break;

      case 'result':
        this.handleResult(message.taskId, message.data, message.projectId);
        break;

      case 'user-question-cancelled':
        this.emitTyped('agent-question-cancelled', message.taskId, message.questionId, this.projectId);
        break;

      case 'render-diagram':
        void this.renderDiagram(message.requestId, message.path);
        break;

      case 'user-question':
        // No UI listening (e.g. headless run): answer "no answer" so the agent
        // proceeds on a stated assumption instead of waiting forever.
        if (this.listenerCount('agent-question') === 0) {
          this.answerQuestion(message.data.questionId, null);
        } else {
          this.emitTyped('agent-question', message.taskId, message.data, message.projectId);
        }
        break;
    }
  }

  /** Render a .drawio file for the architect's review loop and reply to the worker. */
  private async renderDiagram(requestId: string, path: string): Promise<void> {
    let reply: MainToWorkerMessage;
    try {
      if (!this.viewerScript) throw new Error('The draw.io viewer is not bundled in this build');
      const { renderDrawioToPng } = await import('../../diagram-renderer');
      const rendered = await renderDrawioToPng(path, this.viewerScript);
      reply = { type: 'render-result', requestId, ok: true, ...rendered };
    } catch (error) {
      reply = { type: 'render-result', requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.worker?.postMessage(reply);
  }

  /** Deliver the user's answers (or null = dismissed) to the waiting agent. */
  answerQuestion(questionId: string, answers: AgentAnswers | null): void {
    const message: MainToWorkerMessage = { type: 'user-answer', questionId, answers };
    this.worker?.postMessage(message);
  }

  /**
   * Convert ProgressTracker state into an ExecutionProgressData event
   * and emit it to listeners.
   */
  private emitProgressFromTracker(taskId: string, projectId?: string): void {
    const state = this.progressTracker.state;
    const key = `${state.currentPhase}|${state.currentSubtask ?? ''}|${state.currentMessage ?? ''}|${state.completedPhases.length}`;
    if (key === this.lastProgressKey) return;
    this.lastProgressKey = key;
    const progressData: ExecutionProgressData = {
      phase: state.currentPhase,
      phaseProgress: 0, // Detailed progress calculated by UI from phase
      overallProgress: 0,
      currentSubtask: state.currentSubtask ?? undefined,
      message: state.currentMessage,
      completedPhases: state.completedPhases as ExecutionProgressData['completedPhases'],
    };
    this.emitTyped('execution-progress', taskId, progressData, projectId);
  }

  /**
   * Handle the final session result from the worker.
   * Maps SessionResult.outcome to an exit code.
   */
  private handleResult(taskId: string, result: SessionResult, projectId?: string): void {
    // Map outcome to exit code
    const exitCode = result.outcome === 'completed' || result.outcome === 'max_steps' ? 0 : 1;

    // Log the result summary
    const summary = `Session complete: outcome=${result.outcome}, steps=${result.stepsExecuted}, tools=${result.toolCallCount}, duration=${result.durationMs}ms`;
    this.emitTyped('log', taskId, summary, projectId);

    if (result.error) {
      this.emitTyped('error', taskId, result.error.message, projectId);
    }

    this.finish(exitCode);
  }

  /** Collect streamed agent text and emit it to the log in whole lines. */
  private bufferText(text: string): void {
    this.textBuffer += text;
    const lastNewline = this.textBuffer.lastIndexOf('\n');
    if (lastNewline !== -1) {
      const complete = this.textBuffer.slice(0, lastNewline + 1);
      this.textBuffer = this.textBuffer.slice(lastNewline + 1);
      this.emitTyped('log', this.taskId, complete, this.projectId);
    }
    if (this.textBuffer.length > TEXT_FLUSH_CHARS) this.flushText();
  }

  private flushText(): void {
    if (!this.textBuffer) return;
    const text = this.textBuffer;
    this.textBuffer = '';
    this.emitTyped('log', this.taskId, text, this.projectId);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Type-safe emit that matches AgentManagerEvents signatures.
   */
  private emitTyped<K extends keyof AgentManagerEvents>(
    event: K,
    ...args: Parameters<AgentManagerEvents[K]>
  ): void {
    this.emit(event, ...args);
  }

  private cleanup(): void {
    this.worker = null;
  }
}
