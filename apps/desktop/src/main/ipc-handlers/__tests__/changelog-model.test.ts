import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/constants';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: () => ({ id: 'p1', name: 'app', path: '/tmp/app', autoBuildPath: '.vibe-teamlead' }),
    getTasks: () => [],
  },
}));

vi.mock('../../changelog-service', () => ({
  changelogService: {
    on: vi.fn(),
    off: vi.fn(),
    getCommits: () => [{ hash: 'abc', subject: 'feat: x', body: '' }],
  },
}));

const generate = vi.fn(async (_config: Record<string, unknown>) => ({ success: true, text: '## 1.0.0' }));
vi.mock('../../ai/runners/changelog', () => ({ generateChangelog: (config: Record<string, unknown>) => generate(config) }));

vi.mock('../feature-settings-helper', () => ({
  getFeatureSettings: (key: string) => (key === 'utility' ? { model: 'glm-5.3', thinkingLevel: 'high' } : { model: 'sonnet', thinkingLevel: 'low' }),
}));

import { registerChangelogHandlers } from '../changelog-handlers';

describe('changelog generation model', () => {
  it('uses the Utility model from Settings → Agents, not a fixed one', async () => {
    registerChangelogHandlers(() => null);
    const handler = handlers.get(IPC_CHANNELS.CHANGELOG_GENERATE);
    expect(handler).toBeDefined();

    await handler?.({}, { projectId: 'p1', version: '1.0.0', sourceMode: 'git-history', gitHistory: { type: 'recent', count: 5 } });
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());

    const config = generate.mock.calls[0][0];
    expect(config.modelShorthand).toBe('glm-5.3');
    expect(config.thinkingLevel).toBe('high');
  });
});
