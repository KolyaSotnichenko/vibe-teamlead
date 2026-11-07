import { describe, expect, it } from 'vitest';
import { buildModelOptions } from '../ClaudeModelSelect';

const labels = { endpoint: (name: string) => `From ${name}`, current: 'Current' };

describe('buildModelOptions', () => {
  it('offers only what the endpoint lists, nothing built in', () => {
    const options = buildModelOptions('claude-fable-5-1', {
      models: [{ id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { id: 'claude-sonnet-5-5' }],
      endpoint: 'https://api.anthropic.com',
      custom: false,
      fetchedAt: 0,
    }, labels);
    expect(options).toEqual([
      { value: 'claude-fable-5-1', label: 'Claude Fable 5.1 · claude-fable-5-1', group: 'From api.anthropic.com' },
      { value: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', group: 'From api.anthropic.com' },
    ]);
  });

  it('offers nothing to choose when the list could not be loaded', () => {
    expect(buildModelOptions('', { models: [], endpoint: 'https://api.anthropic.com', custom: false, error: 'nope', fetchedAt: 0 }, labels)).toEqual([]);
  });

  it('still names a saved shorthand the endpoint does not list', () => {
    expect(buildModelOptions('opus', null, labels)).toEqual([{ value: 'opus', label: 'Claude Opus 5.5', group: 'Current' }]);
  });

  it('keeps a typed value above the listed models', () => {
    const options = buildModelOptions('my-finetune', {
      models: [{ id: 'qwen3-coder:30b' }],
      endpoint: 'http://localhost:11434',
      custom: true,
      fetchedAt: 0,
    }, labels);
    expect(options[0]).toEqual({ value: 'my-finetune', label: 'my-finetune', group: 'Current' });
    expect(options[1]).toEqual({ value: 'qwen3-coder:30b', label: 'qwen3-coder:30b', group: 'From localhost:11434' });
  });

  it('drops models of removed providers', () => {
    const options = buildModelOptions('gpt-5.2', null, labels);
    expect(options.some((o) => o.value === 'gpt-5.2')).toBe(false);
  });
});
