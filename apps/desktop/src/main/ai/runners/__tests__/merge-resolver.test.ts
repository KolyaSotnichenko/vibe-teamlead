import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockRunClaudeTask = vi.fn();

vi.mock('../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { resolveMergeConflict, createMergeResolverFn } from '../merge-resolver';
import type { MergeResolverConfig } from '../merge-resolver';

// =============================================================================
// Helpers
// =============================================================================

function baseConfig(overrides: Partial<MergeResolverConfig> = {}): MergeResolverConfig {
  return {
    systemPrompt: 'You are a merge conflict resolver.',
    userPrompt: '<<<\nHEAD version\n===\nIncoming version\n>>>',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('resolveMergeConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Successful resolution
  // ---------------------------------------------------------------------------

  it('returns success with trimmed resolved text', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '  Resolved: use incoming version.  ' });

    const result = await resolveMergeConflict(baseConfig());

    expect(result.success).toBe(true);
    expect(result.text).toBe('Resolved: use incoming version.');
    expect(result.error).toBeUndefined();
  });

  it('runs a single tool-less Claude task', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'merged code here' });

    await resolveMergeConflict(baseConfig());

    expect(mockRunClaudeTask).toHaveBeenCalledOnce();
    const callArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(callArgs.systemPrompt).toBe('You are a merge conflict resolver.');
    expect(callArgs.tools).toBeUndefined();
  });

  it('passes userPrompt as the prompt parameter to runClaudeTask', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    const conflict = '<<<\nmy change\n===\ntheir change\n>>>';
    await resolveMergeConflict(baseConfig({ userPrompt: conflict }));

    const callArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(callArgs.prompt).toBe(conflict);
  });

  it('passes systemPrompt config to runClaudeTask', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    const customSystem = 'Custom system prompt.';
    await resolveMergeConflict(baseConfig({ systemPrompt: customSystem }));

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.systemPrompt).toBe(customSystem);
  });

  // ---------------------------------------------------------------------------
  // Default model / thinking level
  // ---------------------------------------------------------------------------

  it('uses haiku model and low thinking level by default', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    await resolveMergeConflict(baseConfig());

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.model).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    await resolveMergeConflict(
      baseConfig({ modelShorthand: 'sonnet', thinkingLevel: 'medium' }),
    );

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.model).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('medium');
  });

  // ---------------------------------------------------------------------------
  // Empty response handling
  // ---------------------------------------------------------------------------

  it('returns failure when LLM returns empty text', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '   ' });

    const result = await resolveMergeConflict(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Empty response from AI');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('returns failure with error message when runClaudeTask throws Error', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('API rate limit'));

    const result = await resolveMergeConflict(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('API rate limit');
  });

  it('returns failure with string coercion when non-Error is thrown', async () => {
    mockRunClaudeTask.mockRejectedValue('connection refused');

    const result = await resolveMergeConflict(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
  });
});

// =============================================================================
// createMergeResolverFn
// =============================================================================

describe('createMergeResolverFn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an async function', () => {
    const fn = createMergeResolverFn();
    expect(typeof fn).toBe('function');
  });

  it('returned function resolves to the resolved text on success', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'merged content' });

    const fn = createMergeResolverFn();
    const result = await fn('system context', 'conflict block');

    expect(result).toBe('merged content');
  });

  it('returned function says so when the model returns nothing', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '   ' });

    await expect(createMergeResolverFn()('system', 'conflict')).rejects.toThrow('Empty response from AI');
  });

  it("returned function passes on the call's error: the user has to see why", async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('API Error: 429 busy'));

    await expect(createMergeResolverFn()('system', 'conflict')).rejects.toThrow('API Error: 429 busy');
  });

  it('uses provided modelShorthand and thinkingLevel', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    const fn = createMergeResolverFn('sonnet', 'medium');
    await fn('sys', 'user');

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.model).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('medium');
  });

  it('defaults to haiku and low when no arguments given', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    const fn = createMergeResolverFn();
    await fn('sys', 'user');

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.model).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('passes system and user arguments as systemPrompt and userPrompt', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'resolved' });

    const fn = createMergeResolverFn();
    await fn('the system prompt', 'the conflict text');

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.systemPrompt).toBe('the system prompt');
    const generateArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(generateArgs.prompt).toBe('the conflict text');
  });
});
