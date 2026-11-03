import { describe, expect, it } from 'vitest';
import { buildModelOptions } from '../ClaudeModelSelect';

const labels = { builtIn: 'Built-in', endpoint: (name: string) => `From ${name}`, current: 'Current' };

describe('buildModelOptions', () => {
  it('lists built-in models first for the Anthropic API', () => {
    const options = buildModelOptions('opus', {
      models: [{ id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }],
      endpoint: 'https://api.anthropic.com',
      custom: false,
      fetchedAt: 0,
    }, labels);
    expect(options[0]).toMatchObject({ value: 'opus', group: 'Built-in' });
    expect(options.at(-1)).toEqual({ value: 'claude-fable-5-1', label: 'Claude Fable 5.1 · claude-fable-5-1', group: 'From api.anthropic.com' });
  });

  it('puts a custom endpoint first and keeps a typed value', () => {
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
