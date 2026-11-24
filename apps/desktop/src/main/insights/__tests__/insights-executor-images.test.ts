import { describe, expect, it, vi } from 'vitest';

const runInsightsQuery = vi.fn();
vi.mock('../../ai/runners/insights', () => ({ runInsightsQuery: (...args: unknown[]) => runInsightsQuery(...args) }));

import { InsightsExecutor } from '../insights-executor';

describe('InsightsExecutor images', () => {
  it('passes the attached images to the query', async () => {
    runInsightsQuery.mockResolvedValue({ text: 'ok', taskSuggestion: null, toolCalls: [] });
    const images = [{ id: '1', filename: 'shot.png', mimeType: 'image/png', size: 3, data: 'AAAA' }];

    await new InsightsExecutor({} as never).execute('p1', '/project', 'What is this?', [], undefined, images);

    expect(runInsightsQuery.mock.calls[0][0].images).toEqual(images);
  });
});
