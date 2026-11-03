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
  getFeatureSettings: () => ({ model: 'sonnet', thinkingLevel: 'medium' }),
}));

import { ClaudeTaskError } from '../ai/claude-code/task';
import type { SessionResult } from '../ai/session/types';
import { TerminalNameGenerator } from '../terminal-name-generator';

describe('TerminalNameGenerator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates a cleaned name using the configured naming model', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '"npm build"' });

    const name = await new TerminalNameGenerator().generateName('npm run build', '/repo');

    expect(name).toBe('npm build');
    const args = mockRunClaudeTask.mock.calls[0][0];
    expect(args.model).toBe('sonnet');
    expect(args.thinkingLevel).toBe('medium');
    expect(args.prompt).toContain('/repo');
  });

  it('emits sdk-rate-limit when the task is rate limited', async () => {
    mockRunClaudeTask.mockRejectedValue(
      new ClaudeTaskError('429', { outcome: 'rate_limited' } as unknown as SessionResult),
    );
    const gen = new TerminalNameGenerator();
    const onRateLimit = vi.fn();
    gen.on('sdk-rate-limit', onRateLimit);

    expect(await gen.generateName('ls')).toBeNull();
    expect(onRateLimit).toHaveBeenCalledWith(expect.objectContaining({ source: 'other' }));
  });

  it('returns null on generic failure', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('boom'));
    expect(await new TerminalNameGenerator().generateName('ls')).toBeNull();
  });
});
