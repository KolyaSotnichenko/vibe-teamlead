import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncQueuePause, useQueuePauseStore } from '../queue-pause-store';

describe('queue pause store', () => {
  beforeEach(() => useQueuePauseStore.setState({ paused: false }));

  it('takes the pause from main and follows its changes', async () => {
    let push: ((paused: boolean) => void) | undefined;
    const api = {
      getPaused: vi.fn(async () => true),
      setPaused: vi.fn(async (p: boolean) => p),
      onPausedChange: vi.fn((cb: (paused: boolean) => void) => {
        push = cb;
        return () => undefined;
      }),
    };
    const stop = syncQueuePause(api);
    await vi.waitFor(() => expect(useQueuePauseStore.getState().paused).toBe(true));
    push?.(false);
    expect(useQueuePauseStore.getState().paused).toBe(false);
    stop();
  });

  it('resume asks main and keeps what main answers', async () => {
    const api = { getPaused: vi.fn(async () => true), setPaused: vi.fn(async () => false), onPausedChange: () => () => undefined };
    useQueuePauseStore.setState({ paused: true });
    await useQueuePauseStore.getState().resume(api);
    expect(api.setPaused).toHaveBeenCalledWith(false);
    expect(useQueuePauseStore.getState().paused).toBe(false);
  });
});
