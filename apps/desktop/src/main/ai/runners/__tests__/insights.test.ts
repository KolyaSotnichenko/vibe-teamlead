import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { StreamEvent } from '../../session/types';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockRunClaudeTask = vi.fn();

vi.mock('../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
  READ_TOOLS: ['Read', 'Glob', 'Grep'],
  RESEARCH_TOOLS: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
}));

// Filesystem mocks — project context files are absent by default
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn().mockReturnValue([]);

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}));

// json-repair is used for safeParseJson in the insights runner
vi.mock('../../../utils/json-repair', () => ({
  safeParseJson: (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

// parseLLMJson is used for task suggestion extraction
vi.mock('../../schema/structured-output', () => ({
  parseLLMJson: vi.fn().mockReturnValue(null),
}));

vi.mock('../../schema/insight-extractor', () => ({
  TaskSuggestionSchema: {},
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { runInsightsQuery } from '../insights';
import type { InsightsConfig, InsightsStreamEvent } from '../insights';
import { parseLLMJson } from '../../schema/structured-output';

// =============================================================================
// Helpers
// =============================================================================

/** Make runClaudeTask emit the given StreamEvents, then resolve */
function emitEvents(events: StreamEvent[], finalText = '') {
  mockRunClaudeTask.mockImplementation(async (opts: { onEvent?: (e: StreamEvent) => void }) => {
    for (const e of events) opts.onEvent?.(e);
    return { text: finalText, session: { outcome: 'completed' } };
  });
}

function text(t: string): StreamEvent {
  return { type: 'text-delta', text: t };
}

function toolCall(toolName: string, args: Record<string, unknown>, id = 'c1'): StreamEvent {
  return { type: 'tool-call', toolName, toolCallId: id, args };
}

function toolResult(toolName: string, id = 'c1'): StreamEvent {
  return { type: 'tool-result', toolName, toolCallId: id, result: 'ok', durationMs: 1, isError: false };
}

function errorEvent(message: string): StreamEvent {
  return { type: 'error', error: { code: 'error', message, retryable: false } };
}

function taskArgs() {
  return mockRunClaudeTask.mock.calls[0][0];
}

function baseConfig(overrides: Partial<InsightsConfig> = {}): InsightsConfig {
  return {
    projectDir: '/project',
    message: 'How does authentication work?',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runInsightsQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitEvents([]);
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    vi.mocked(parseLLMJson).mockReturnValue(null);
  });

  // ---------------------------------------------------------------------------
  // Successful run
  // ---------------------------------------------------------------------------

  it('returns response text accumulated from text-delta events', async () => {
    emitEvents([text('Authentication uses JWT tokens.'), text(' Tokens expire after 1 hour.')]);

    const result = await runInsightsQuery(baseConfig());

    expect(result.text).toBe('Authentication uses JWT tokens. Tokens expire after 1 hour.');
    expect(result.taskSuggestion).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it('falls back to the final assistant text when nothing was streamed', async () => {
    emitEvents([], 'Final answer.');

    const result = await runInsightsQuery(baseConfig());

    expect(result.text).toBe('Final answer.');
  });

  it('returns empty text and no task suggestion when session produces nothing', async () => {
    const result = await runInsightsQuery(baseConfig());

    expect(result.text).toBe('');
    expect(result.taskSuggestion).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Task suggestion extraction
  // ---------------------------------------------------------------------------

  it('extracts task suggestion from response text when marker present', async () => {
    const suggestion = {
      title: 'Add rate limiting',
      description: 'Implement per-user rate limiting on auth endpoints',
      metadata: { category: 'security', complexity: 'medium', impact: 'high' },
    };
    emitEvents([text(`Here is my suggestion.\n__TASK_SUGGESTION__:${JSON.stringify(suggestion)}\n`)]);
    vi.mocked(parseLLMJson).mockReturnValueOnce(suggestion as unknown as ReturnType<typeof parseLLMJson>);

    const result = await runInsightsQuery(baseConfig());

    expect(result.taskSuggestion).not.toBeNull();
    expect(result.taskSuggestion?.title).toBe('Add rate limiting');
    expect(result.taskSuggestion?.metadata.category).toBe('security');
  });

  it('returns null taskSuggestion when no marker in response', async () => {
    emitEvents([text('No suggestions here.')]);

    const result = await runInsightsQuery(baseConfig());

    expect(result.taskSuggestion).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Tool call tracking
  // ---------------------------------------------------------------------------

  it('tracks tool calls in result.toolCalls', async () => {
    emitEvents([
      toolCall('Read', { file_path: 'src/auth.ts' }, 'c1'),
      toolResult('Read', 'c1'),
      toolCall('Glob', { pattern: '**/*.ts' }, 'c2'),
      toolResult('Glob', 'c2'),
    ]);

    const result = await runInsightsQuery(baseConfig());

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('Read');
    expect(result.toolCalls[1].name).toBe('Glob');
  });

  it('extracts file_path from Read tool call args', async () => {
    emitEvents([toolCall('Read', { file_path: 'src/auth.ts' })]);

    const result = await runInsightsQuery(baseConfig());

    expect(result.toolCalls[0].input).toBe('src/auth.ts');
  });

  it('extracts pattern from Grep/Glob tool call args', async () => {
    emitEvents([toolCall('Grep', { pattern: 'useAuth' })]);

    const result = await runInsightsQuery(baseConfig());

    expect(result.toolCalls[0].input).toBe('pattern: useAuth');
  });

  // ---------------------------------------------------------------------------
  // Stream callbacks
  // ---------------------------------------------------------------------------

  it('forwards text-delta events to onStream callback', async () => {
    emitEvents([text('chunk1'), text('chunk2')]);

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    expect(events.filter((e) => e.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'chunk1' },
      { type: 'text-delta', text: 'chunk2' },
    ]);
  });

  it('forwards tool-start events for tool-call events', async () => {
    emitEvents([toolCall('Grep', { pattern: 'login' })]);

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([{ type: 'tool-start', name: 'Grep', input: 'pattern: login' }]);
  });

  it('forwards tool-end events for tool-result events', async () => {
    emitEvents([toolResult('Read')]);

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([{ type: 'tool-end', name: 'Read' }]);
  });

  it('forwards error events as plain messages', async () => {
    emitEvents([errorEvent('tool failed')]);

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([{ type: 'error', error: 'tool failed' }]);
  });

  it('ignores thinking and usage events', async () => {
    emitEvents([
      { type: 'thinking-delta', text: 'hmm' },
      { type: 'usage-update', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Error propagation
  // ---------------------------------------------------------------------------

  it('rethrows when runClaudeTask rejects', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('API timeout'));

    await expect(runInsightsQuery(baseConfig())).rejects.toThrow('API timeout');
  });

  it('emits error event to callback before rethrowing', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('rate limited'));

    const events: InsightsStreamEvent[] = [];
    await expect(runInsightsQuery(baseConfig(), (e) => events.push(e))).rejects.toThrow('rate limited');

    expect(events).toEqual([{ type: 'error', error: 'rate limited' }]);
  });

  it('does not duplicate an error the session already streamed', async () => {
    mockRunClaudeTask.mockImplementation(async (opts: { onEvent?: (e: StreamEvent) => void }) => {
      opts.onEvent?.(errorEvent('auth failed'));
      throw new Error('auth failed');
    });

    const events: InsightsStreamEvent[] = [];
    await expect(runInsightsQuery(baseConfig(), (e) => events.push(e))).rejects.toThrow('auth failed');

    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Task configuration
  // ---------------------------------------------------------------------------

  it('runs a read-only insights session in the project directory', async () => {
    await runInsightsQuery(baseConfig());

    const args = taskArgs();
    expect(args.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(args.cwd).toBe('/project');
    expect(args.agentType).toBe('insights');
    expect(args.maxTurns).toBe(30);
    expect(args.allowedWritePaths).toBeUndefined();
    expect(args.systemPrompt).toContain('__TASK_SUGGESTION__');
  });

  it('uses sonnet model and medium thinking level by default', async () => {
    await runInsightsQuery(baseConfig());

    expect(taskArgs().model).toBe('sonnet');
    expect(taskArgs().thinkingLevel).toBe('medium');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    await runInsightsQuery(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'low' }));

    expect(taskArgs().model).toBe('haiku');
    expect(taskArgs().thinkingLevel).toBe('low');
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();
    await runInsightsQuery(baseConfig({ abortSignal: controller.signal }));

    expect(taskArgs().abortSignal).toBe(controller.signal);
  });

  // ---------------------------------------------------------------------------
  // History handling
  // ---------------------------------------------------------------------------

  it('includes conversation history in the prompt when provided', async () => {
    await runInsightsQuery(
      baseConfig({
        message: 'What about refresh tokens?',
        history: [
          { role: 'user', content: 'How does auth work?' },
          { role: 'assistant', content: 'It uses JWT.' },
        ],
      }),
    );

    const prompt = taskArgs().prompt as string;
    expect(prompt).toContain('How does auth work?');
    expect(prompt).toContain('It uses JWT.');
    expect(prompt).toContain('What about refresh tokens?');
  });

  it('uses message directly as prompt when history is empty', async () => {
    await runInsightsQuery(baseConfig({ message: 'What is the entry point?' }));

    expect(taskArgs().prompt).toBe('What is the entry point?');
  });
});
