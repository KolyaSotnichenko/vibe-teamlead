import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { GatewayPrices, IPCResult, ProjectUsageSummary } from '../../shared/types';
import { configuredGatewayModels, readProjectUsage } from '../ai/usage/usage-ledger';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';

export function registerUsageHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USAGE_GET, async (_e, projectId: string): Promise<IPCResult<ProjectUsageSummary>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const settings = readSettingsFile();
    const prices = (settings?.gatewayModelPrices ?? {}) as GatewayPrices;
    return { success: true, data: await readProjectUsage(project.path, prices, configuredGatewayModels(settings)) };
  });
}
