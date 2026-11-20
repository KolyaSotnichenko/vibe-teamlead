/**
 * Before the app quits, the Settings dialog saves what its open section changed (it saves on
 * leaving a section or closing, and a quit is neither). Main asks the window and waits for its
 * answer, never longer than the timeout. No Electron import: testable with fakes.
 */

import { randomUUID } from 'node:crypto';

import { IPC_CHANNELS } from '../shared/constants';

interface WindowLike {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, ...args: unknown[]) => void; isDestroyed: () => boolean };
}

interface IpcLike {
  on: (channel: string, listener: (event: unknown, id: unknown) => void) => unknown;
  removeListener: (channel: string, listener: (event: unknown, id: unknown) => void) => unknown;
}

export type FlushOutcome = 'flushed' | 'timeout' | 'no-window';

export function flushRendererBeforeQuit(win: WindowLike | null | undefined, ipc: IpcLike, timeoutMs = 3000): Promise<FlushOutcome> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve('no-window');
  const id = randomUUID();
  return new Promise<FlushOutcome>((resolve) => {
    const finish = (outcome: FlushOutcome) => {
      clearTimeout(timer);
      ipc.removeListener(IPC_CHANNELS.SETTINGS_FLUSHED_BEFORE_QUIT, onDone);
      resolve(outcome);
    };
    const onDone = (_event: unknown, answered: unknown) => {
      if (answered === id) finish('flushed');
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    ipc.on(IPC_CHANNELS.SETTINGS_FLUSHED_BEFORE_QUIT, onDone);
    try {
      win.webContents.send(IPC_CHANNELS.SETTINGS_FLUSH_BEFORE_QUIT, id);
    } catch {
      finish('no-window');
    }
  });
}
