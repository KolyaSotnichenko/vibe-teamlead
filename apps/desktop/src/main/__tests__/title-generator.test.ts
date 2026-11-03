import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();

vi.mock('../ai/claude-code/task', () => {
  class ClaudeTaskError extends Error {
    constructor(
      message: string,
      readonly session: { outcome: string },
    ) {
      super(message);
    }
  }
  return { runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args), ClaudeTaskError };
});

vi.mock('../ipc-handlers/feature-settings-helper', () => ({
  getActiveProviderFeatureSettings: () => ({ model: 'haiku', thinkingLevel: 'low' }),
}));

vi.mock('../sentry', () => ({ safeBreadcrumb: vi.fn(), safeCaptureException: vi.fn() }));

import { ClaudeTaskError } from '../ai/claude-code/task';
import type { SessionResult } from '../ai/session/types';
import { TitleGenerator } from '../title-generator';

const taskError = (outcome: string) =>
  new ClaudeTaskError('failed', { outcome } as unknown as SessionResult);

describe('TitleGenerator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates a cleaned title with the configured naming model', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '"title: add dark mode toggle"' });

    const title = await new TitleGenerator().generateTitle('Users want dark mode');

    expect(title).toBe('Add dark mode toggle');
    const args = mockRunClaudeTask.mock.calls[0][0];
    expect(args.model).toBe('haiku');
    expect(args.thinkingLevel).toBe('low');
    expect(args.prompt).toContain('Users want dark mode');
    expect(args.tools).toBeUndefined();
  });

  it('returns null on empty response', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '  ' });
    expect(await new TitleGenerator().generateTitle('x')).toBeNull();
  });

  it('emits sdk-rate-limit when the task is rate limited', async () => {
    mockRunClaudeTask.mockRejectedValue(taskError('rate_limited'));
    const gen = new TitleGenerator();
    const onRateLimit = vi.fn();
    gen.on('sdk-rate-limit', onRateLimit);

    expect(await gen.generateTitle('x')).toBeNull();
    expect(onRateLimit).toHaveBeenCalledWith(expect.objectContaining({ source: 'title-generator' }));
  });

  it('returns null without a rate-limit event on other failures', async () => {
    mockRunClaudeTask.mockRejectedValue(taskError('auth_failure'));
    const gen = new TitleGenerator();
    const onRateLimit = vi.fn();
    gen.on('sdk-rate-limit', onRateLimit);

    expect(await gen.generateTitle('x')).toBeNull();
    expect(onRateLimit).not.toHaveBeenCalled();
  });
});
