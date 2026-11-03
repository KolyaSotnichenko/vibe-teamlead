import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, ToolCheck } from '../../shared/types';
import { checkTools } from '../tools-check';

export function registerToolsCheckHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TOOLS_CHECK, async (): Promise<IPCResult<ToolCheck[]>> => {
    try {
      return { success: true, data: await checkTools() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check tools' };
    }
  });
}
