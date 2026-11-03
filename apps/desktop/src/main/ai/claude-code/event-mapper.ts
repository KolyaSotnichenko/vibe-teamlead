/**
 * Translate Claude Agent SDK messages into Vibe Teamlead StreamEvents and
 * accumulate everything needed for the final SessionResult.
 *
 * The rest of the app (task logs, kanban progress, terminals) consumes
 * StreamEvent, so this is the only place that knows the SDK's message shapes.
 */

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import { ErrorCode } from '../session/error-classifier';
import type {
  SessionError,
  SessionMessage,
  SessionOutcome,
  StreamEvent,
  TokenUsage,
} from '../session/types';

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface ContentBlockLike {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const AUTH_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
]);

export function toTokenUsage(usage: UsageLike | null | undefined): TokenUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const promptTokens = input + cacheRead + cacheCreation;
  return {
    promptTokens,
    completionTokens: output,
    totalTokens: promptTokens + output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

function toolResultText(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const texts = content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text);
  return texts.length === content.length ? texts.join('\n') : content;
}

export class SessionAccumulator {
  stepsExecuted = 0;
  toolCallCount = 0;
  usage: TokenUsage = toTokenUsage(undefined);
  costUsd = 0;
  sessionId: string | undefined;
  result: SDKResultMessage | undefined;
  readonly messages: SessionMessage[] = [];

  private assistantError: string | undefined;
  private rateLimited = false;
  private currentMessageId: string | undefined;
  private currentText = '';
  private readonly toolStarts = new Map<string, { name: string; startedAt: number }>();

  constructor(
    private readonly emit: (event: StreamEvent) => void,
    initialMessages: SessionMessage[] = [],
  ) {
    this.messages.push(...initialMessages);
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.sessionId = message.session_id;
        return;

      case 'stream_event': {
        const event = message.event;
        if (event.type !== 'content_block_delta') return;
        if (event.delta.type === 'text_delta') {
          this.emit({ type: 'text-delta', text: event.delta.text });
        } else if (event.delta.type === 'thinking_delta') {
          this.emit({ type: 'thinking-delta', text: event.delta.thinking });
        }
        return;
      }

      case 'assistant': {
        if (message.error) this.assistantError = message.error;
        const id = message.message.id;
        if (id !== this.currentMessageId) {
          this.finishStep();
          this.currentMessageId = id;
          this.stepsExecuted += 1;
        }
        for (const block of message.message.content as ContentBlockLike[]) {
          if (block.type === 'text' && block.text) {
            this.currentText += block.text;
          } else if (block.type === 'tool_use' && block.id && block.name) {
            this.toolCallCount += 1;
            this.toolStarts.set(block.id, { name: block.name, startedAt: Date.now() });
            this.emit({
              type: 'tool-call',
              toolName: block.name,
              toolCallId: block.id,
              args: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
        this.lastStepUsage = toTokenUsage(message.message.usage as UsageLike);
        return;
      }

      case 'user': {
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as ContentBlockLike[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const start = this.toolStarts.get(block.tool_use_id);
          this.toolStarts.delete(block.tool_use_id);
          this.emit({
            type: 'tool-result',
            toolName: start?.name ?? 'unknown',
            toolCallId: block.tool_use_id,
            result: toolResultText(block.content),
            durationMs: start ? Date.now() - start.startedAt : 0,
            isError: block.is_error === true,
          });
        }
        return;
      }

      case 'rate_limit_event':
        if (message.rate_limit_info.status === 'rejected') this.rateLimited = true;
        return;

      case 'result':
        this.finishStep();
        this.result = message;
        this.usage = toTokenUsage(message.usage as UsageLike);
        this.costUsd = message.total_cost_usd;
        this.emit({ type: 'usage-update', usage: this.usage });
        return;

      default:
        return;
    }
  }

  private lastStepUsage: TokenUsage = toTokenUsage(undefined);

  private finishStep(): void {
    if (this.currentMessageId === undefined) return;
    if (this.currentText) {
      this.messages.push({ role: 'assistant', content: this.currentText });
      this.currentText = '';
    }
    this.emit({ type: 'step-finish', stepNumber: this.stepsExecuted, usage: this.lastStepUsage });
    this.currentMessageId = undefined;
  }

  /** Decide the session outcome once the stream is over (or threw). */
  resolveOutcome(aborted: boolean, thrown?: unknown): { outcome: SessionOutcome; error?: SessionError } {
    if (aborted) return { outcome: 'cancelled' };

    if (this.assistantError && AUTH_ERRORS.has(this.assistantError)) {
      return {
        outcome: 'auth_failure',
        error: { code: ErrorCode.AUTH_FAILURE, message: `Authentication failed (${this.assistantError})`, retryable: false },
      };
    }
    if (this.rateLimited || this.assistantError === 'rate_limit') {
      return {
        outcome: 'rate_limited',
        error: { code: ErrorCode.RATE_LIMITED, message: 'Rate limit reached', retryable: true },
      };
    }
    if (this.assistantError === 'billing_error') {
      return {
        outcome: 'error',
        error: { code: ErrorCode.BILLING_ERROR, message: 'Billing error on the Anthropic account', retryable: false },
      };
    }

    const result = this.result;
    if (result?.subtype === 'success' && !result.is_error) return { outcome: 'completed' };
    if (result?.subtype === 'error_max_turns') {
      return {
        outcome: 'max_steps',
        error: { code: ErrorCode.MAX_STEPS, message: 'Reached the maximum number of turns', retryable: true },
      };
    }

    const message =
      thrown instanceof Error
        ? thrown.message
        : result && 'errors' in result && result.errors.length > 0
          ? result.errors.join('; ')
          : result?.subtype === 'success'
            ? result.result
            : 'Claude Code session ended without a result';
    return {
      outcome: 'error',
      error: { code: ErrorCode.GENERIC, message, retryable: false, cause: thrown },
    };
  }
}
