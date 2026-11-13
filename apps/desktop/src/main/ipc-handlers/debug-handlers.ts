/**
 * Debug IPC Handlers
 *
 * Handles debug-related IPC operations:
 * - Getting debug info for bug reports
 * - Opening logs folder
 * - Copying debug info to clipboard
 * - Listing log files
 */

import { ipcMain, shell, clipboard } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  getSystemInfo,
  getLogsPath,
  getRecentErrors,
  generateDebugReport,
  logger
} from '../app-logger';

export interface DebugInfo {
  systemInfo: Record<string, string>;
  recentErrors: string[];
  logsPath: string;
  debugReport: string;
}

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
}

/**
 * Register debug-related IPC handlers
 */
export function registerDebugHandlers(): void {
  // Get comprehensive debug info
  ipcMain.handle(IPC_CHANNELS.DEBUG_GET_INFO, async (): Promise<DebugInfo> => {
    logger.info('Debug info requested');
    return {
      systemInfo: getSystemInfo(),
      recentErrors: getRecentErrors(20),
      logsPath: getLogsPath(),
      debugReport: generateDebugReport()
    };
  });

  // Open logs folder in system file explorer
  ipcMain.handle(IPC_CHANNELS.DEBUG_OPEN_LOGS_FOLDER, async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const logsPath = getLogsPath();
      logger.info('Opening logs folder:', logsPath);
      await shell.openPath(logsPath);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to open logs folder:', error);
      return { success: false, error: errorMessage };
    }
  });

  // Copy debug info to clipboard
  ipcMain.handle(IPC_CHANNELS.DEBUG_COPY_DEBUG_INFO, async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const debugReport = generateDebugReport();
      clipboard.writeText(debugReport);
      logger.info('Debug info copied to clipboard');
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to copy debug info:', error);
      return { success: false, error: errorMessage };
    }
  });

  logger.info('Debug IPC handlers registered');
}
