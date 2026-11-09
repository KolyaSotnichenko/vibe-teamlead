/**
 * Preload of the Preview's page view (sandboxed, isolated). It runs the notes overlay
 * in the page's own world before the page's scripts, and relays window messages between
 * the overlay and the main process. Nothing else of Electron reaches the page.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { FROM_HOST, FROM_OVERLAY } from './protocol';

const source = ipcRenderer.sendSync('preview:overlay-source') as unknown;
if (typeof source === 'string' && source) {
  contextBridge.executeInMainWorld({
    func: (code: string) => {
      // eslint-disable-next-line no-new-func
      new Function(code)();
    },
    args: [source],
  });
}

window.addEventListener('message', (event) => {
  const data = event.data as { source?: unknown } | null;
  if (event.source !== window || !data || data.source !== FROM_OVERLAY) return;
  ipcRenderer.send('preview:overlay-event', data);
});

ipcRenderer.on('preview:overlay-command', (_event, command: Record<string, unknown>) => {
  window.postMessage({ ...command, source: FROM_HOST }, '*');
});
