/**
 * The queue pause, mirrored from the main process (the Telegram bot's /stop_all pauses the
 * queue). While paused, the board starts no queued task.
 */
import { create } from 'zustand';

type QueueApi = Window['electronAPI']['queue'];

interface QueuePauseState {
  paused: boolean;
  resume: (api?: QueueApi) => Promise<void>;
}

export const useQueuePauseStore = create<QueuePauseState>((set) => ({
  paused: false,
  resume: async (api = window.electronAPI.queue) => {
    set({ paused: await api.setPaused(false) });
  },
}));

/** Follow main's pause; returns the unsubscribe */
export function syncQueuePause(api: QueueApi | undefined = window.electronAPI?.queue): () => void {
  // An older preload (or a test window) has no queue API: nothing is paused then
  if (!api) return () => undefined;
  const off = api.onPausedChange((paused) => useQueuePauseStore.setState({ paused }));
  api
    .getPaused()
    .then((paused) => useQueuePauseStore.setState({ paused }))
    .catch(() => undefined);
  return off;
}
