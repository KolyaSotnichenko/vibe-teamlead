import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';

/** window.electronAPI.queue — the queue pause (the Telegram bot's /stop_all sets it) */
export interface QueueAPI {
  getPaused: () => Promise<boolean>;
  setPaused: (paused: boolean) => Promise<boolean>;
  onPausedChange: (callback: (paused: boolean) => void) => () => void;
}

export const createQueueAPI = (): QueueAPI => ({
  getPaused: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_PAUSED_GET),
  setPaused: (paused: boolean) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_PAUSED_SET, paused),
  onPausedChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, paused: boolean) => callback(paused);
    ipcRenderer.on(IPC_CHANNELS.QUEUE_PAUSED_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QUEUE_PAUSED_CHANGED, handler);
  },
});
