import { describe, expect, it } from 'vitest';
import { getReasoningTypeForModel } from '../models';

describe('getReasoningTypeForModel', () => {
  it('current Claude models (Opus, Sonnet, Haiku 5.5) think adaptively with an effort level', () => {
    for (const m of ['opus', 'opus-1m', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(getReasoningTypeForModel(m)).toBe('adaptive_effort');
    }
  });

  it('Haiku 4.5 has no thinking the app can set; older Opus keeps a token budget', () => {
    expect(getReasoningTypeForModel('claude-haiku-4-5')).toBe('none');
    expect(getReasoningTypeForModel('opus-4.5')).toBe('thinking_tokens');
  });
});
