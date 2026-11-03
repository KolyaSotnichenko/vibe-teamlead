import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readSettingsFile, store, search } = vi.hoisted(() => ({
  readSettingsFile: vi.fn(),
  store: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../../../settings-utils', () => ({ readSettingsFile }));
vi.mock('../../../ipc-handlers/context/memory-service-factory', () => ({
  getMemoryService: async () => ({ store, search }),
}));

import type { ExtractedInsights } from '../../runners/insight-extractor';
import {
  formatMemories,
  insightsToEntries,
  memoryPromptSection,
  recordSessionInsights,
  rememberForAgent,
} from '../agent-memory';
import type { Memory } from '../types';

const insights: ExtractedInsights = {
  file_insights: [{ file: 'src/auth/session.ts', insight: 'Refresh tokens rotate on every use; keep the old one for 30 s' }],
  patterns_discovered: ['API handlers return Result objects instead of throwing'],
  gotchas_discovered: ['Vitest needs TZ=UTC or the date tests fail', 'Vitest needs TZ=UTC or the date tests fail', 'short'],
  approach_outcome: {
    success: false,
    approach_used: 'Mocking fetch globally',
    why_it_worked: null,
    why_it_failed: 'MSW intercepts first, so global mocks never fire',
    alternatives_tried: [],
  },
  recommendations: [],
  subtask_id: '2.1',
  session_num: 1,
  success: false,
  changed_files: ['src/auth/session.ts'],
};

function memory(partial: Partial<Memory>): Memory {
  return { id: 'm', type: 'gotcha', content: 'x', confidence: 0.8, tags: [], relatedFiles: [], relatedModules: [], createdAt: '', lastAccessedAt: '', accessCount: 0, scope: 'global', source: 'agent_explicit', sessionId: '', provenanceSessionIds: [], ...partial } as Memory;
}

describe('insightsToEntries', () => {
  it('turns a session into typed, deduplicated memories for the project', () => {
    const entries = insightsToEntries({ projectId: 'p1', specId: '002-auth' }, insights);
    expect(entries.map((e) => e.type)).toEqual(['gotcha', 'pattern', 'module_insight', 'error_pattern']);
    expect(entries.every((e) => e.projectId === 'p1' && e.source === 'observer_inferred')).toBe(true);
    expect(entries[0].tags).toEqual(['002-auth', 'subtask:2.1']);
    expect(entries[2].content).toBe('src/auth/session.ts: Refresh tokens rotate on every use; keep the old one for 30 s');
    expect(entries[2].relatedFiles).toEqual(['src/auth/session.ts']);
    expect(entries[3].content).toBe('Did not work: Mocking fetch globally — MSW intercepts first, so global mocks never fire');
  });
});

describe('recordSessionInsights', () => {
  beforeEach(() => {
    store.mockReset();
    store.mockResolvedValue('id');
    readSettingsFile.mockReset();
  });

  it('stores the memories', async () => {
    readSettingsFile.mockReturnValue({});
    expect(await recordSessionInsights({ projectId: 'p1' }, insights)).toBe(4);
    expect(store).toHaveBeenCalledTimes(4);
  });

  it('stores nothing when memory is off', async () => {
    readSettingsFile.mockReturnValue({ memoryEnabled: false });
    expect(await recordSessionInsights({ projectId: 'p1' }, insights)).toBe(0);
    expect(store).not.toHaveBeenCalled();
  });
});

describe('rememberForAgent', () => {
  it('stores what the agent chose to keep, as agent_explicit', async () => {
    readSettingsFile.mockReturnValue({});
    store.mockResolvedValue('id');
    await rememberForAgent({ projectId: 'p1', specId: 's1' }, { type: 'decision', content: 'We use Drizzle, not Prisma, for migrations', files: ['db/schema.ts'] });
    expect(store).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'decision', source: 'agent_explicit', projectId: 'p1', relatedFiles: ['db/schema.ts'], tags: ['s1'] }),
    );
    await expect(rememberForAgent({ projectId: 'p1' }, { type: 'gotcha', content: 'tiny' })).rejects.toThrow(/too short/);
  });
});

describe('memoryPromptSection', () => {
  beforeEach(() => {
    search.mockReset();
    readSettingsFile.mockReturnValue({});
  });

  it('lists the relevant memories of this project', async () => {
    search.mockResolvedValue([memory({ type: 'gotcha', content: 'Vitest needs TZ=UTC', relatedFiles: ['vitest.config.ts'] })]);
    const section = await memoryPromptSection('p1', 'date tests');
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', query: 'date tests', excludeDeprecated: true }));
    expect(section.startsWith('## Project memory')).toBe(true);
    expect(section).toContain('- [gotcha] Vitest needs TZ=UTC (files: vitest.config.ts)');
  });

  it('is empty without memories or when memory is off', async () => {
    search.mockResolvedValue([]);
    expect(await memoryPromptSection('p1', 'anything')).toBe('');
    readSettingsFile.mockReturnValue({ memoryEnabled: false });
    search.mockResolvedValue([memory({})]);
    expect(await memoryPromptSection('p1', 'anything')).toBe('');
  });
});

describe('formatMemories', () => {
  it('writes one line per memory', () => {
    expect(formatMemories([memory({ type: 'pattern', content: 'Use Result' }), memory({ type: 'decision', content: 'No ORM' })])).toBe(
      '- [pattern] Use Result\n- [decision] No ORM',
    );
  });
});
