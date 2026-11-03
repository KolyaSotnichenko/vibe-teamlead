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

// Mock filesystem: prompt files exist by default
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { runIdeation, IDEATION_TYPES, IDEATION_TYPE_LABELS } from '../ideation';
import type { IdeationConfig, IdeationStreamEvent } from '../ideation';

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

function errorEvent(message: string): StreamEvent {
  return { type: 'error', error: { code: 'error', message, retryable: false } };
}

function taskArgs() {
  return mockRunClaudeTask.mock.calls[0][0];
}

function baseConfig(overrides: Partial<IdeationConfig> = {}): IdeationConfig {
  return {
    projectDir: '/project',
    outputDir: '/project/.vibe-teamlead/ideation',
    promptsDir: '/app/prompts',
    ideationType: 'code_improvements',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runIdeation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitEvents([]);
    // Prompt file exists and has content by default
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('Analyze the codebase for improvements.');
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  it('exports all expected IDEATION_TYPES', () => {
    expect(IDEATION_TYPES).toContain('code_improvements');
    expect(IDEATION_TYPES).toContain('ui_ux_improvements');
    expect(IDEATION_TYPES).toContain('documentation_gaps');
    expect(IDEATION_TYPES).toContain('security_hardening');
    expect(IDEATION_TYPES).toContain('performance_optimizations');
    expect(IDEATION_TYPES).toContain('code_quality');
    expect(IDEATION_TYPES).toHaveLength(6);
  });

  it('exports human-readable labels for all ideation types', () => {
    for (const type of IDEATION_TYPES) {
      expect(IDEATION_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // Successful run
  // ---------------------------------------------------------------------------

  it('returns success with accumulated text from text-delta events', async () => {
    emitEvents([
      { type: 'text-delta', text: 'Found ' },
      { type: 'text-delta', text: '3 improvements.' },
    ]);

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(true);
    expect(result.text).toBe('Found 3 improvements.');
    expect(result.error).toBeUndefined();
  });

  it('falls back to the final assistant text when nothing was streamed', async () => {
    emitEvents([], 'Wrote ideas.');

    const result = await runIdeation(baseConfig());

    expect(result.text).toBe('Wrote ideas.');
  });

  // ---------------------------------------------------------------------------
  // Task configuration
  // ---------------------------------------------------------------------------

  it('uses sonnet and medium thinking by default', async () => {
    await runIdeation(baseConfig());

    expect(taskArgs().model).toBe('sonnet');
    expect(taskArgs().thinkingLevel).toBe('medium');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    await runIdeation(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'low' }));

    expect(taskArgs().model).toBe('haiku');
    expect(taskArgs().thinkingLevel).toBe('low');
  });

  it('runs an ideation session with research tools and writes confined to outputDir', async () => {
    await runIdeation(baseConfig());

    const args = taskArgs();
    expect(args.agentType).toBe('ideation');
    expect(args.cwd).toBe('/project');
    expect(args.tools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Write', 'Edit']);
    expect(args.tools).not.toContain('Bash');
    expect(args.allowedWritePaths).toEqual(['/project/.vibe-teamlead/ideation']);
    expect(args.maxTurns).toBe(30);
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();
    await runIdeation(baseConfig({ abortSignal: controller.signal }));

    expect(taskArgs().abortSignal).toBe(controller.signal);
  });

  // ---------------------------------------------------------------------------
  // Stream callbacks
  // ---------------------------------------------------------------------------

  it('forwards text-delta events to onStream callback', async () => {
    emitEvents([
      { type: 'text-delta', text: 'hello' },
      { type: 'text-delta', text: ' world' },
    ]);

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    const textEvents = events.filter((e) => e.type === 'text-delta');
    expect(textEvents).toHaveLength(2);
    expect((textEvents[0] as { type: 'text-delta'; text: string }).text).toBe('hello');
  });

  it('forwards tool-use events from tool-call events', async () => {
    emitEvents([{ type: 'tool-call', toolName: 'Glob', toolCallId: 'c1', args: {} }]);

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([{ type: 'tool-use', name: 'Glob' }]);
  });

  it('forwards error events as plain messages', async () => {
    emitEvents([errorEvent('stream error')]);

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([{ type: 'error', error: 'stream error' }]);
  });

  // ---------------------------------------------------------------------------
  // Prompt file not found
  // ---------------------------------------------------------------------------

  it('returns failure when prompt file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toContain('Prompt not found');
    expect(mockRunClaudeTask).not.toHaveBeenCalled();
  });

  it('returns failure when prompt file cannot be read', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  // ---------------------------------------------------------------------------
  // Error handling — runClaudeTask rejects
  // ---------------------------------------------------------------------------

  it('returns failure when runClaudeTask rejects', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('API error'));

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('API error');
  });

  it('keeps partial streamed text on failure', async () => {
    mockRunClaudeTask.mockImplementation(async (opts: { onEvent?: (e: StreamEvent) => void }) => {
      opts.onEvent?.({ type: 'text-delta', text: 'partial' });
      throw new Error('boom');
    });

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('partial');
  });

  it('emits error event to callback when runClaudeTask rejects', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('network failure'));

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    expect(events).toEqual([{ type: 'error', error: 'network failure' }]);
  });

  it('does not duplicate an error the session already streamed', async () => {
    mockRunClaudeTask.mockImplementation(async (opts: { onEvent?: (e: StreamEvent) => void }) => {
      opts.onEvent?.(errorEvent('rate limited'));
      throw new Error('rate limited');
    });

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Ideation type routing — checks the correct prompt file is loaded
  // ---------------------------------------------------------------------------

  it.each(IDEATION_TYPES)('loads the correct prompt file for ideation type: %s', async (type) => {
    await runIdeation(baseConfig({ ideationType: type }));

    expect(mockExistsSync).toHaveBeenCalledWith(expect.stringMatching(/^\/app\/prompts\/ideation_.*\.md$/));
  });

  // ---------------------------------------------------------------------------
  // Context injection
  // ---------------------------------------------------------------------------

  it('includes projectDir and outputDir in the system prompt', async () => {
    await runIdeation(
      baseConfig({ projectDir: '/my/project', outputDir: '/my/project/.vibe-teamlead/ideation' }),
    );

    const systemPrompt = taskArgs().systemPrompt as string;
    expect(systemPrompt).toContain('Analyze the codebase for improvements.');
    expect(systemPrompt).toContain('**Project Directory**: /my/project');
    expect(systemPrompt).toContain('**Output Directory**: /my/project/.vibe-teamlead/ideation');
  });

  it('injects maxIdeasPerType into the context', async () => {
    await runIdeation(baseConfig({ maxIdeasPerType: 10 }));

    expect(taskArgs().systemPrompt).toContain('**Max Ideas**: 10');
    expect(taskArgs().prompt).toContain('up to 10');
  });
});
