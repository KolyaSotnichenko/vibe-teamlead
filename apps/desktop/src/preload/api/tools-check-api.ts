import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { ToolsCheckAPI } from '../../shared/types/tools-check';

export const createToolsCheckAPI = (): ToolsCheckAPI => ({
  check: () => ipcRenderer.invoke(IPC_CHANNELS.TOOLS_CHECK),
});
