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

import { generateChangelog } from '../changelog';
import type { ChangelogConfig } from '../changelog';

// =============================================================================
// Helpers
// =============================================================================

function baseConfig(overrides: Partial<ChangelogConfig> = {}): ChangelogConfig {
  return {
    projectName: 'TestProject',
    version: '1.0.0',
    sourceMode: 'tasks',
    tasks: [
      { title: 'Add dark mode', description: 'Implemented dark mode toggle', category: 'feature' },
    ],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('generateChangelog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Successful generation
  // ---------------------------------------------------------------------------

  it('returns success with trimmed text when LLM responds', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '  ## [1.0.0]\n\n### Added\n- Dark mode\n  ' });

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(true);
    expect(result.text).toBe('## [1.0.0]\n\n### Added\n- Dark mode');
    expect(result.error).toBeUndefined();
  });

  it('passes system prompt, prompt and model settings to runClaudeTask', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig());

    expect(mockRunClaudeTask).toHaveBeenCalledOnce();
    const callArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain('technical writer');
    expect(callArgs.prompt).toContain('TestProject');
    expect(callArgs.prompt).toContain('1.0.0');
    expect(callArgs).toHaveProperty('model');
    expect(callArgs).toHaveProperty('thinkingLevel');
    expect(callArgs.tools).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Task mode — prompt content
  // ---------------------------------------------------------------------------

  it('includes task titles and categories in prompt for tasks mode', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });

    const config = baseConfig({
      tasks: [
        { title: 'My feature', description: 'desc', category: 'feature', issueNumber: 42 },
      ],
    });
    await generateChangelog(config);

    const prompt = mockRunClaudeTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('My feature');
    expect(prompt).toContain('feature');
    expect(prompt).toContain('#42');
  });

  // ---------------------------------------------------------------------------
  // Git history / branch-diff modes
  // ---------------------------------------------------------------------------

  it('includes commit messages in prompt for git-history mode', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(
      baseConfig({ sourceMode: 'git-history', commits: 'feat: add login\nfix: bug #5' }),
    );

    const prompt = mockRunClaudeTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('feat: add login');
  });

  it('truncates commits to 5000 chars', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });
    const longCommits = 'x'.repeat(10_000);

    await generateChangelog(baseConfig({ sourceMode: 'branch-diff', commits: longCommits }));

    const prompt = mockRunClaudeTask.mock.calls[0][0].prompt as string;
    // The 'x'.repeat(10000) block should be truncated — prompt must not exceed
    // 5000 'x' chars plus surrounding text
    const xCount = (prompt.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(5000);
  });

  // ---------------------------------------------------------------------------
  // Previous changelog style reference
  // ---------------------------------------------------------------------------

  it('includes previousChangelog when provided', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(
      baseConfig({ previousChangelog: '## [0.9.0]\n\n### Added\n- Old feature' }),
    );

    const prompt = mockRunClaudeTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Previous Changelog');
    expect(prompt).toContain('0.9.0');
  });

  // ---------------------------------------------------------------------------
  // Default model / thinking level
  // ---------------------------------------------------------------------------

  it('uses sonnet model and low thinking level by default', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig());

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.model).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'high' }));

    const clientArgs = mockRunClaudeTask.mock.calls[0][0];
    expect(clientArgs.model).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Empty response handling
  // ---------------------------------------------------------------------------

  it('returns failure when LLM returns empty text', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '   ' });

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Empty response from AI');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('returns failure with error message when runClaudeTask throws', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Rate limit exceeded');
  });

  it('returns failure with string coercion when non-Error is thrown', async () => {
    mockRunClaudeTask.mockRejectedValue('timeout');

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
  });
});
