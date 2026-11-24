import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentSession = vi.fn();
vi.mock('../runner', () => ({ runAgentSession: (...args: unknown[]) => runAgentSession(...args) }));

import { runClaudeTask } from '../task';

describe('runClaudeTask images', () => {
  beforeEach(() => {
    runAgentSession.mockReset().mockResolvedValue({ outcome: 'completed', messages: [] });
  });

  it('gives the session the images to send with the prompt', async () => {
    const images = [{ mediaType: 'image/png', data: 'AAAA' }];
    await runClaudeTask({ systemPrompt: 's', prompt: 'p', images, auth: { apiKey: 'k' }, bundled: {} });
    expect(runAgentSession.mock.calls[0][0].images).toEqual(images);
  });

  it('sends none when there are none', async () => {
    await runClaudeTask({ systemPrompt: 's', prompt: 'p', auth: { apiKey: 'k' }, bundled: {} });
    expect(runAgentSession.mock.calls[0][0].images).toBeUndefined();
  });
});
