import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../../../shared/types';
import { applyMemoryPanelChange, toMemoryPanelConfig } from '../MemorySettings';

const base = { memoryEmbeddingProvider: 'openai', globalOpenAIApiKey: 'sk-1' } as unknown as AppSettings;

describe('MemorySettings mapping', () => {
  it('reads memory as on unless it was turned off, the same rule the agents use', () => {
    expect(toMemoryPanelConfig(base).enabled).toBe(true);
    expect(toMemoryPanelConfig({ ...base, memoryEnabled: false }).enabled).toBe(false);
    expect(toMemoryPanelConfig(base).embeddingProvider).toBe('openai');
    expect(toMemoryPanelConfig(base).openaiApiKey).toBe('sk-1');
  });

  it('writes the app settings keys the memory engine reads, and nothing else changes', () => {
    const off = applyMemoryPanelChange(base, { enabled: false });
    expect(off.memoryEnabled).toBe(false);
    expect(off.memoryEmbeddingProvider).toBe('openai');

    const ollama = applyMemoryPanelChange(base, { embeddingProvider: 'ollama', ollamaEmbeddingModel: 'qwen3-embedding:4b', openaiApiKey: '' });
    expect(ollama.memoryEmbeddingProvider).toBe('ollama');
    expect(ollama.memoryOllamaEmbeddingModel).toBe('qwen3-embedding:4b');
    expect(ollama.globalOpenAIApiKey).toBeUndefined();
    expect(base.memoryEmbeddingProvider).toBe('openai');
  });
});
