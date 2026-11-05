import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import type { AgentExecutorConfig, WorkerMessage } from '../types';
import type { SessionResult } from '../../session/types';

// =============================================================================
// Mocks
// =============================================================================

// Track created workers
const createdWorkers: EventEmitter[] = [];

vi.mock('worker_threads', () => {
  const { EventEmitter: EE } = require('events') as typeof import('events');

  class MockWorkerImpl extends EE {
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);
    workerData: unknown;
    constructor(_path: string, opts?: { workerData?: unknown }) {
      super();
      this.workerData = opts?.workerData;
      createdWorkers.push(this);
    }
  }

  return { Worker: MockWorkerImpl };
});

function getWorker(): EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  const w = createdWorkers[createdWorkers.length - 1];
  if (!w) throw new Error('No worker created');
  return w as EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
}

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('url', () => ({
  fileURLToPath: (url: string) => url.replace('file://', ''),
}));

// Mock ProgressTracker
const mockProcessEvent = vi.fn();
vi.mock('../../session/progress-tracker', () => ({
  ProgressTracker: class {
    processEvent = mockProcessEvent;
    state = {
      currentPhase: 'initializing' as const,
      currentSubtask: null,
      currentMessage: 'Starting...',
      completedPhases: [],
    };
  },
}));

// Project memory (main-process side of memory-request)
const memoryMocks = vi.hoisted(() => ({
  memoryPromptSection: vi.fn(),
  searchProjectMemory: vi.fn(),
  formatMemories: vi.fn(),
  rememberForAgent: vi.fn(),
  recordSessionInsights: vi.fn(),
}));
vi.mock('../../memory/agent-memory', () => ({
  ...memoryMocks,
  AGENT_MEMORY_TYPES: ['gotcha', 'decision', 'pattern', 'module_insight', 'error_pattern', 'requirement'],
}));

// The project's design system is read from the project store (Electron app paths)
vi.mock('../../../project-store', () => ({ projectStore: { getProject: () => undefined } }));

// The architect setting is read from the app settings file
const { readArchitectMode } = vi.hoisted(() => ({ readArchitectMode: vi.fn(() => 'never') }));
vi.mock('../../orchestration/architect-setting', () => ({ readArchitectMode }));

// The format-and-lint switch is read from the app settings file
const { isFormatOnEditEnabled } = vi.hoisted(() => ({ isFormatOnEditEnabled: vi.fn(() => false) }));
vi.mock('../../claude-code/format-setting', () => ({ isFormatOnEditEnabled }));
const { isLspEnabled } = vi.hoisted(() => ({ isLspEnabled: vi.fn(() => false) }));
vi.mock('../../claude-code/lsp-setting', () => ({ isLspEnabled }));

// Import after mocks
import { WorkerBridge } from '../worker-bridge';

// =============================================================================
// Helpers
// =============================================================================

function createConfig(overrides: Partial<AgentExecutorConfig> = {}): AgentExecutorConfig {
  return {
    taskId: 'task-123',
    projectId: 'proj-456',
    processType: 'task-execution',
    session: {
      agentType: 'coder',
      systemPrompt: 'test',
      initialMessages: [{ role: 'user', content: 'hello' }],
      maxSteps: 10,
      specDir: '/specs',
      projectDir: '/project',
      modelId: 'claude-sonnet-4-20250514',
      toolContext: { cwd: '/project', projectDir: '/project', specDir: '/specs' },
    },
    ...overrides,
  };
}

function createSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 5,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs: 3000,
    toolCallCount: 3,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkerBridge', () => {
  let bridge: WorkerBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    createdWorkers.length = 0;
    bridge = new WorkerBridge();
  });

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  describe('spawn', () => {
    it('creates a worker and sets isActive to true', () => {
      bridge.spawn(createConfig());
      expect(bridge.isActive).toBe(true);
      expect(createdWorkers.length).toBe(1);
    });

    it('throws if worker already active', () => {
      bridge.spawn(createConfig());
      expect(() => bridge.spawn(createConfig())).toThrow('already has an active worker');
    });

    it('fills the architect mode from the app settings unless the session sets it', () => {
      bridge.spawn(createConfig());
      const session = (getWorker() as unknown as { workerData: { session: { architectMode?: string } } }).workerData.session;
      expect(session.architectMode).toBe('never');
      expect(readArchitectMode).toHaveBeenCalled();

      bridge = new WorkerBridge();
      const config = createConfig();
      config.session.architectMode = 'always';
      bridge.spawn(config);
      expect((getWorker() as unknown as { workerData: { session: { architectMode?: string } } }).workerData.session.architectMode).toBe('always');
    });

    it('fills the format-and-lint switch from the app settings unless the session sets it', () => {
      bridge.spawn(createConfig());
      expect((getWorker() as unknown as { workerData: { session: { formatOnEdit?: boolean } } }).workerData.session.formatOnEdit).toBe(false);
      expect(isFormatOnEditEnabled).toHaveBeenCalled();

      bridge = new WorkerBridge();
      const config = createConfig();
      config.session.formatOnEdit = true;
      bridge.spawn(config);
      expect((getWorker() as unknown as { workerData: { session: { formatOnEdit?: boolean } } }).workerData.session.formatOnEdit).toBe(true);
    });

    it('fills the language-servers switch from the app settings unless the session sets it', () => {
      bridge.spawn(createConfig());
      expect((getWorker() as unknown as { workerData: { session: { lspEnabled?: boolean } } }).workerData.session.lspEnabled).toBe(false);
      expect(isLspEnabled).toHaveBeenCalled();
      bridge = new WorkerBridge();
      const config = createConfig();
      config.session.lspEnabled = true;
      bridge.spawn(config);
      expect((getWorker() as unknown as { workerData: { session: { lspEnabled?: boolean } } }).workerData.session.lspEnabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Message relay
  // ---------------------------------------------------------------------------

  describe('memory requests', () => {
    async function reply(): Promise<Record<string, unknown>> {
      await vi.waitFor(() => expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory-result' })));
      return getWorker().postMessage.mock.calls.map((c) => c[0]).find((m) => m.type === 'memory-result');
    }

    it("answers a prompt request with this project's memory section", async () => {
      memoryMocks.memoryPromptSection.mockResolvedValue('## Project memory\n- [gotcha] x');
      bridge.spawn(createConfig());
      getWorker().emit('message', { type: 'memory-request', taskId: 'task-123', requestId: 'r1', specId: '002', request: { op: 'prompt', query: 'auth' } });
      expect(await reply()).toEqual({ type: 'memory-result', requestId: 'r1', ok: true, text: '## Project memory\n- [gotcha] x' });
      expect(memoryMocks.memoryPromptSection).toHaveBeenCalledWith('proj-456', 'auth', undefined);
    });

    it('stores insights under the project and task', async () => {
      memoryMocks.recordSessionInsights.mockResolvedValue(3);
      bridge.spawn(createConfig());
      const insights = { subtask_id: '1.1' };
      getWorker().emit('message', { type: 'memory-request', taskId: 'task-123', requestId: 'r2', specId: '002', request: { op: 'insights', insights } });
      expect((await reply()).text).toBe('3');
      expect(memoryMocks.recordSessionInsights).toHaveBeenCalledWith({ projectId: 'proj-456', specId: '002' }, insights);
    });

    it('replies with the error instead of throwing', async () => {
      memoryMocks.rememberForAgent.mockRejectedValue(new Error('Memory is turned off in Settings'));
      bridge.spawn(createConfig());
      getWorker().emit('message', { type: 'memory-request', taskId: 'task-123', requestId: 'r3', request: { op: 'remember', memoryType: 'decision', content: 'We picked X because Y' } });
      expect(await reply()).toEqual({ type: 'memory-result', requestId: 'r3', ok: false, error: 'Memory is turned off in Settings' });
    });
  });

  describe('message relay', () => {
    it('emits log events from worker log messages', () => {
      const handler = vi.fn();
      bridge.on('log', handler);
      bridge.spawn(createConfig());

      const msg: WorkerMessage = { type: 'log', taskId: 'task-123', data: 'hello', projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'hello', 'proj-456');
    });

    it('emits error events from worker error messages', () => {
      const handler = vi.fn();
      bridge.on('error', handler);
      bridge.spawn(createConfig());

      const msg: WorkerMessage = { type: 'error', taskId: 'task-123', data: 'fail', projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'fail', 'proj-456');
    });

    it('emits execution-progress events from worker progress messages', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      const progressData = { phase: 'building' as const, phaseProgress: 50, overallProgress: 25 };
      const msg: WorkerMessage = { type: 'execution-progress', taskId: 'task-123', data: progressData as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', progressData, 'proj-456');
    });

    it('feeds stream-events to progress tracker and emits progress', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      const streamEvent = { type: 'tool-call' as const, toolName: 'bash', args: {} };
      const msg: WorkerMessage = { type: 'stream-event', taskId: 'task-123', data: streamEvent as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(mockProcessEvent).toHaveBeenCalledWith(streamEvent);
      expect(handler).toHaveBeenCalled();
    });

    it('emits log for text-delta stream events', () => {
      const handler = vi.fn();
      bridge.on('log', handler);
      bridge.spawn(createConfig());

      const send = (data: unknown) =>
        getWorker().emit('message', { type: 'stream-event', taskId: 'task-123', data: data as never } as WorkerMessage);
      send({ type: 'text-delta', text: 'some ' });
      send({ type: 'text-delta', text: 'output\nnext' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith('task-123', 'some output\n', 'proj-456');

      // The rest of the line is flushed at the end of the step.
      send({ type: 'step-finish', stepNumber: 1, usage: {} });
      expect(handler).toHaveBeenLastCalledWith('task-123', 'next', 'proj-456');
    });
  });

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  describe('result handling', () => {
    it('maps completed outcome to exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'completed' });
      const msg: WorkerMessage = { type: 'result', taskId: 'task-123', data: result, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('maps max_steps outcome to exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'max_steps' });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', 'proj-456');
    });

    it('maps error outcome to exit code 1', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.on('error', vi.fn()); // Prevent unhandled error throw
      bridge.on('log', vi.fn());
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'error', error: { message: 'boom', code: 'unknown', retryable: false } });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
    });

    it('releases the worker thread after the result and emits exit only once', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.on('log', vi.fn());
      bridge.spawn(createConfig());
      const worker = getWorker();
      worker.emit('message', { type: 'result', taskId: 'task-123', data: createSessionResult() });
      worker.emit('exit', 0);
      expect(worker.terminate).toHaveBeenCalled();
      expect(exitHandler).toHaveBeenCalledTimes(1);
    });

    it('still emits exit when the worker crashes (error, then exit)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.on('error', vi.fn());
      bridge.spawn(createConfig());
      const worker = getWorker();
      worker.emit('error', new Error('uncaught'));
      worker.emit('exit', 1);
      expect(exitHandler).toHaveBeenCalledTimes(1);
      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('emits error event when result has an error', () => {
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'error', error: { message: 'boom', code: 'unknown', retryable: false } });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(errorHandler).toHaveBeenCalledWith('task-123', 'boom', undefined);
    });

    it('logs summary before exit', () => {
      const logHandler = vi.fn();
      bridge.on('log', logHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult();
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(logHandler).toHaveBeenCalledWith(
        'task-123',
        expect.stringContaining('Session complete'),
        undefined,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Worker crash handling
  // ---------------------------------------------------------------------------

  describe('crash handling', () => {
    it('emits error and cleans up on worker error event', () => {
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.spawn(createConfig());

      getWorker().emit('error', new Error('Worker crashed'));

      expect(errorHandler).toHaveBeenCalledWith('task-123', 'Worker crashed', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('emits exit on worker exit event (non-zero code)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      getWorker().emit('exit', 1);

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('does not emit exit if worker reference already cleaned up (result already handled)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      // Simulate result handling first (which cleans up)
      const worker = getWorker();
      const result = createSessionResult();
      worker.emit('message', { type: 'result', taskId: 'task-123', data: result });
      exitHandler.mockClear();

      // Then worker exits - should not double-emit
      worker.emit('exit', 0);
      expect(exitHandler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Termination
  // ---------------------------------------------------------------------------

  describe('terminate', () => {
    it('asks the worker to abort and lets it exit on its own', async () => {
      bridge.spawn(createConfig());
      const worker = getWorker();
      worker.postMessage.mockImplementation((m: { type: string }) => {
        if (m.type === 'abort') setImmediate(() => worker.emit('exit', 0));
      });

      await bridge.terminate();

      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'abort' });
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(bridge.isActive).toBe(false);
    });

    it('force-terminates a worker that does not stop within the grace period', async () => {
      vi.useFakeTimers();
      bridge.spawn(createConfig());
      const worker = getWorker();
      const stopping = bridge.terminate();
      await vi.advanceTimersByTimeAsync(5000);
      await stopping;
      expect(worker.terminate).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('handles termination when no worker is active', async () => {
      await expect(bridge.terminate()).resolves.toBeUndefined();
    });

    it('handles postMessage failure on dead worker', async () => {
      vi.useFakeTimers();
      bridge.spawn(createConfig());
      getWorker().postMessage.mockImplementation(() => {
        throw new Error('Worker already dead');
      });

      const stopping = bridge.terminate();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stopping).resolves.toBeUndefined();
      vi.useRealTimers();
    });
  });
});
