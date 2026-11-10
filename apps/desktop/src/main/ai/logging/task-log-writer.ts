/**
 * Task Log Writer
 * ===============
 *
 * Writes task_logs.json files during TypeScript agent session execution.
 * This replaces the Python backend's TaskLogger/LogStorage system.
 *
 * The writer maps AI SDK stream events to the TaskLogs JSON format
 * expected by the frontend log rendering system (TaskLogs component).
 *
 * Phase mapping (Phase → TaskLogPhase):
 *   spec     → planning
 *   planning → planning
 *   coding   → coding
 *   qa       → validation
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TaskLogs, TaskLogPhase, TaskPhaseLog, TaskLogPhaseStatus, TaskLogEntry, TaskLogEntryType } from '../../../shared/types';
import type { StreamEvent } from '../session/types';
import type { Phase } from '../config/types';
import { writeFileReplacingSync } from '../safe-write';

// =============================================================================
// Phase Mapping
// =============================================================================

/** Map execution phase to log phase */
/** A pipeline phase, or the designer's own log phase */
export type LogPhase = Phase | 'design';

function toLogPhase(phase: LogPhase | undefined): TaskLogPhase {
  switch (phase) {
    case 'design':
      return 'design';
    case 'spec':
    case 'planning':
      return 'planning';
    case 'coding':
      return 'coding';
    case 'qa':
      return 'validation';
    default:
      return 'coding'; // Fallback for unknown phases
  }
}

// =============================================================================
// Task logger
// =============================================================================

/**
 * A log line that outlives the session: sent to the live log and kept in
 * task_logs.json. For what explains a run afterwards (which agent ran, how its
 * session ended, an MCP server that didn't start, a check that blocked approval).
 */
export function taskLogger(
  post: (line: string) => void,
  writer: Pick<TaskLogWriter, 'logText'> | null | undefined,
  phase: LogPhase,
): (line: string) => void {
  return (line) => {
    post(line);
    writer?.logText(line, phase, 'info');
  };
}

/**
 * Why a run failed, kept in task_logs.json under the phase it stopped in. A build
 * can fail before any session starts, and then nothing else records the reason.
 */
export function logRunFailure(
  post: (line: string) => void,
  writer: Pick<TaskLogWriter, 'logText'> | null | undefined,
  error: string | undefined,
): void {
  if (!error) return;
  const line = `Run failed: ${error}`;
  post(line);
  writer?.logText(line, undefined, 'error');
}

// =============================================================================
// TaskLogWriter
// =============================================================================

/**
 * Writes task_logs.json to the spec directory during agent execution.
 *
 * Usage:
 * ```ts
 * const writer = new TaskLogWriter(specDir, specId);
 * writer.startPhase('planning');
 * writer.processEvent(streamEvent); // called for each stream event
 * writer.endPhase('planning', true);
 * ```
 */
export class TaskLogWriter {
  private readonly logFile: string;
  private data: TaskLogs;
  private currentPhase: TaskLogPhase = 'planning';
  private currentSubtask: string | undefined;
  private pendingText = '';
  private pendingTextPhase: TaskLogPhase | undefined;

  constructor(specDir: string, specId: string) {
    this.logFile = join(specDir, 'task_logs.json');
    this.data = this.loadOrCreate(specDir, specId);
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Mark a phase as started. Flushes any pending text from the previous phase.
   */
  startPhase(phase: LogPhase, message?: string): void {
    this.flushPendingText();
    const logPhase = toLogPhase(phase);
    this.currentPhase = logPhase;

    // Auto-close any other active phases (handles resume/restart scenarios)
    for (const [key, phaseData] of Object.entries(this.data.phases)) {
      if (key !== logPhase && phaseData.status === 'active') {
        this.phaseLog(key as TaskLogPhase).status = 'completed';
        this.phaseLog(key as TaskLogPhase).completed_at = this.timestamp();
      }
    }

    this.phaseLog(logPhase).status = 'active';
    this.phaseLog(logPhase).started_at = this.timestamp();

    const content = message ?? `Starting ${logPhase} phase`;
    this.addEntry(logPhase, 'phase_start', content);
    this.save();
  }

  /**
   * Mark a phase as completed or failed.
   */
  endPhase(phase: LogPhase, success: boolean, message?: string): void {
    this.flushPendingText();
    const logPhase = toLogPhase(phase);
    const status: TaskLogPhaseStatus = success ? 'completed' : 'failed';
    this.phaseLog(logPhase).status = status;
    this.phaseLog(logPhase).completed_at = this.timestamp();

    const content = message ?? `${success ? 'Completed' : 'Failed'} ${logPhase} phase`;
    this.addEntry(logPhase, 'phase_end', content);
    this.save();
  }

  /**
   * Set the current subtask ID for subsequent log entries.
   */
  setSubtask(subtaskId: string | undefined): void {
    this.currentSubtask = subtaskId;
  }

  /**
   * Process a stream event from the AI SDK session.
   * Routes to the appropriate log entry writer.
   */
  processEvent(event: StreamEvent, phase?: LogPhase): void {
    const logPhase = phase ? toLogPhase(phase) : this.currentPhase;

    switch (event.type) {
      case 'text-delta':
        this.accumulateText(event.text, logPhase);
        break;

      case 'tool-call': {
        // Flush pending text before the tool call entry
        this.flushPendingText();
        if (event.toolName === 'Agent') {
          // No subagent_type: an ad-hoc subagent the agent wrote itself (Claude Code's general-purpose)
          this.subagentCalls.set(event.toolCallId, typeof event.args.subagent_type === 'string' ? event.args.subagent_type : 'general-purpose');
        }
        this.writeToolStart(logPhase, event.toolName, this.extractToolInput(event.toolName, event.args), {
          tool_use_id: event.toolCallId,
          ...this.subagentOf(event.parentToolCallId),
        });
        break;
      }

      case 'tool-result':
        this.writeToolEnd(logPhase, event.toolName, event.isError, event.result, {
          tool_use_id: event.toolCallId,
          ...this.subagentOf(event.parentToolCallId),
        });
        break;

      case 'step-finish':
        // Flush accumulated text on step finish
        this.flushPendingText();
        break;

      case 'error':
        this.flushPendingText();
        this.addEntry(logPhase, 'error', event.error.message);
        this.save();
        break;

      default:
        // Ignore thinking-delta, usage-update
        break;
    }
  }

  /**
   * Write a plain text log message to the current phase.
   */
  logText(content: string, phase?: LogPhase, entryType: TaskLogEntryType = 'text'): void {
    this.flushPendingText();
    const logPhase = phase ? toLogPhase(phase) : this.currentPhase;
    this.addEntry(logPhase, entryType, content);
    this.save();
  }

  /**
   * Flush any accumulated text and save.
   */
  flush(): void {
    this.flushPendingText();
    this.save();
  }

  /**
   * Get the current log data.
   */
  getData(): TaskLogs {
    return this.data;
  }

  // ===========================================================================
  // Private: Core Writing
  // ===========================================================================

  private addEntry(
    phase: TaskLogPhase,
    type: TaskLogEntryType,
    content: string,
    extra?: Partial<TaskLogEntry>
  ): void {
    const entry: TaskLogEntry = {
      timestamp: this.timestamp(),
      type,
      content: content.slice(0, 2000), // Reasonable cap to prevent huge entries
      phase,
      ...(this.currentSubtask ? { subtask_id: this.currentSubtask } : {}),
      ...extra,
    };

    this.phaseLog(phase).entries.push(entry);
  }

  /** A phase's log, created when missing (a file from before the design phase) */
  private phaseLog(phase: TaskLogPhase): TaskPhaseLog {
    let log = this.data.phases[phase];
    if (!log) {
      log = { phase, status: 'pending', started_at: null, completed_at: null, entries: [] };
      this.data.phases[phase] = log;
    }
    return log;
  }

  /** Agent tool call id → the subagent it started */
  private subagentCalls = new Map<string, string>();

  private subagentOf(parentToolCallId: string | undefined): Partial<TaskLogEntry> {
    if (!parentToolCallId) return {};
    return { subagent: this.subagentCalls.get(parentToolCallId) ?? 'subagent' };
  }

  private writeToolStart(phase: TaskLogPhase, toolName: string, toolInput?: string, extra: Partial<TaskLogEntry> = {}): void {
    const content = `[${toolName}] ${toolInput || ''}`.trim();
    this.addEntry(phase, 'tool_start', content, {
      tool_name: toolName,
      tool_input: toolInput,
      ...extra,
    });
    this.save();
  }

  private writeToolEnd(
    phase: TaskLogPhase,
    toolName: string,
    isError: boolean,
    result: unknown,
    extra: Partial<TaskLogEntry> = {}
  ): void {
    const status = isError ? 'Error' : 'Done';
    const content = `[${toolName}] ${status}`;

    // Serialize result as detail (expandable in UI)
    let detail: string | undefined;
    if (result !== null && result !== undefined) {
      const raw = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      // Cap at 10KB to match Python behavior
      detail = raw.length > 10240 ? `${raw.slice(0, 10240)}\n\n... [truncated]` : raw;
    }

    this.addEntry(phase, 'tool_end', content, {
      tool_name: toolName,
      ...(detail ? { detail, collapsed: true } : {}),
      ...extra,
    });
    this.save();
  }

  // ===========================================================================
  // Private: Text Accumulation
  // ===========================================================================

  /**
   * Accumulate text deltas instead of writing one entry per delta.
   * Flushes happen on step-finish, tool-call, or phase changes.
   */
  private accumulateText(text: string, phase: TaskLogPhase): void {
    if (this.pendingTextPhase && this.pendingTextPhase !== phase) {
      // Phase changed mid-accumulation — flush what we have
      this.flushPendingText();
    }
    this.pendingText += text;
    this.pendingTextPhase = phase;
  }

  private flushPendingText(): void {
    if (!this.pendingText.trim()) {
      this.pendingText = '';
      this.pendingTextPhase = undefined;
      return;
    }

    const phase = this.pendingTextPhase ?? this.currentPhase;
    const content = this.pendingText.trim();

    // Write as a text entry
    this.addEntry(phase, 'text', content.slice(0, 4000));
    this.save();

    this.pendingText = '';
    this.pendingTextPhase = undefined;
  }

  // ===========================================================================
  // Private: Tool Input Extraction
  // ===========================================================================

  /**
   * Extract a brief display string from tool arguments.
   * Shows the primary input (file path, command, pattern, etc.)
   */
  private extractToolInput(toolName: string, args: Record<string, unknown>): string | undefined {
    const truncate = (s: string, max = 200): string =>
      s.length > max ? `${s.slice(0, max - 3)}...` : s;

    switch (toolName) {
      case 'Read':
        return typeof args.file_path === 'string' ? truncate(args.file_path) : undefined;
      case 'Write':
        return typeof args.file_path === 'string' ? truncate(args.file_path) : undefined;
      case 'Edit':
        return typeof args.file_path === 'string' ? truncate(args.file_path) : undefined;
      case 'Bash':
        return typeof args.command === 'string' ? truncate(args.command) : undefined;
      case 'Glob':
        return typeof args.pattern === 'string' ? truncate(args.pattern) : undefined;
      case 'Grep':
        return typeof args.pattern === 'string' ? truncate(args.pattern) : undefined;
      case 'WebFetch':
        return typeof args.url === 'string' ? truncate(args.url) : undefined;
      case 'WebSearch':
        return typeof args.query === 'string' ? truncate(args.query) : undefined;
      case 'Agent': {
        // "explorer · Find where invoices are exported"
        const who = typeof args.subagent_type === 'string' ? args.subagent_type : 'general-purpose';
        const what = typeof args.description === 'string' ? args.description : '';
        return truncate(what ? `${who} · ${what}` : who);
      }
      default: {
        // Generic: try common field names
        const value = args.file_path ?? args.path ?? args.command ?? args.query ?? args.pattern;
        return typeof value === 'string' ? truncate(value) : undefined;
      }
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private loadOrCreate(_specDir: string, specId: string): TaskLogs {
    if (existsSync(this.logFile)) {
      try {
        const content = readFileSync(this.logFile, 'utf-8');
        const loaded = JSON.parse(content) as TaskLogs;
        // Logs written before the design phase existed
        loaded.phases.design ??= { phase: 'design', status: 'pending', started_at: null, completed_at: null, entries: [] };
        return loaded;
      } catch {
        // Corrupted file — start fresh
      }
    }

    const now = this.timestamp();
    return {
      spec_id: specId,
      created_at: now,
      updated_at: now,
      phases: {
        planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
        design: { phase: 'design', status: 'pending', started_at: null, completed_at: null, entries: [] },
        coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
        validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
      },
    };
  }

  private save(): void {
    this.data.updated_at = this.timestamp();
    try {
      // Ensure directory exists
      const dir = dirname(this.logFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileReplacingSync(this.logFile, JSON.stringify(this.data, null, 2));
    } catch {
      // Non-fatal: log write failures don't break execution
      // (The UI will just show an empty log section)
    }
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
