import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, ProjectUsageSummary } from '../../shared/types';

/** window.electronAPI.usage */
export interface UsageAPI {
  /** Tokens (and Anthropic API cost) of every Claude Code session in the project */
  get: (projectId: string) => Promise<IPCResult<ProjectUsageSummary>>;
}

export const createUsageAPI = (): UsageAPI => ({
  get: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.USAGE_GET, projectId),
});
