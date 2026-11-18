/**
 * Cloud architecture (TerraVision, experimental): the project's Context →
 * Architecture tab and the readiness line in Settings → Agents.
 */

import { join } from 'node:path';

import { ipcMain, shell } from 'electron';

import { IPC_CHANNELS, getSpecsDir } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { CloudArchitectureFile, CloudArchitectureView, CloudToolsState } from '../../shared/types/cloud-architecture';
import { isCloudDiagramsEnabled } from '../ai/cloud-diagrams/cloud-setting';
import { cloudArchitectureFile, cloudArchitectureView, type ViewInput } from '../ai/cloud-diagrams/project-view';
import { detectCloudTools, installHints } from '../ai/cloud-diagrams/terravision';
import { getPlatformKey } from '../platform';
import { findOnPath } from '../platform/exec';
import { projectStore } from '../project-store';
import { findTaskWorktree } from '../worktree-paths';

const FILES: CloudArchitectureFile[] = ['svg', 'drawio', 'html', 'folder', 'designed-drawio', 'designed-svg'];

function viewInput(projectId: string): ViewInput | undefined {
  const project = projectStore.getProject(projectId);
  if (!project) return undefined;
  const specs = join(project.path, getSpecsDir(project.autoBuildPath));
  return {
    projectPath: project.path,
    tasks: projectStore.getTasks(projectId).map((task) => ({ id: task.id, title: task.title, specId: task.specId, status: task.status })),
    specDirs: (task) => {
      const worktree = findTaskWorktree(project.path, task.specId);
      return [join(specs, task.specId), ...(worktree ? [join(worktree, getSpecsDir(project.autoBuildPath), task.specId)] : [])];
    },
    enabled: isCloudDiagramsEnabled(),
    tools: detectCloudTools((name) => findOnPath(name)),
    platform: getPlatformKey(),
  };
}

export function registerCloudArchitectureHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CLOUD_ARCHITECTURE_GET, async (_e, projectId: string): Promise<IPCResult<CloudArchitectureView>> => {
    const input = viewInput(projectId);
    if (!input) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: await cloudArchitectureView(input) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_ARCHITECTURE_OPEN, async (_e, projectId: string, file: CloudArchitectureFile): Promise<IPCResult> => {
    const input = viewInput(projectId);
    if (!input || !FILES.includes(file)) return { success: false, error: 'File not found' };
    const target = await cloudArchitectureFile(input, file);
    if (!target) return { success: false, error: 'File not found' };
    const error = await shell.openPath(target);
    return error ? { success: false, error } : { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_DIAGRAMS_TOOLS, async (): Promise<IPCResult<CloudToolsState>> => {
    const tools = detectCloudTools((name) => findOnPath(name));
    const platform = getPlatformKey();
    return { success: true, data: { ready: tools.ready, drawFromCode: tools.drawFromCode, missing: tools.missing, hints: installHints(platform) } };
  });
}
