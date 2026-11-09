/**
 * Placeholders left in the project's UI files, for the board. A text search over the files
 * git tracks in the project folder, run when the board asks: after merges, it sees main.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, LooseEnd } from '../../shared/types';
import { findLooseEnds, looseEndFiles, looseEndKey } from '../ai/verification/loose-ends';
import { getToolPath } from '../cli-tool-manager';
import { projectStore } from '../project-store';

const run = promisify(execFile);

/** Larger files are generated or data, not pages */
const FILE_MAX = 512 * 1024;

/** The project's loose ends, without the ones the owner said to leave. */
export async function projectLooseEnds(projectPath: string, ignored: string[], git = 'git'): Promise<LooseEnd[]> {
  const { stdout } = await run(git, ['ls-files', '-z'], { cwd: projectPath, maxBuffer: 64 * 1024 * 1024 });
  const files = looseEndFiles(stdout.split('\0').filter(Boolean));
  const contents = new Map<string, string>();
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(projectPath, file), 'utf-8').catch(() => '');
      if (text.length <= FILE_MAX) contents.set(file, text);
    }),
  );
  const skip = new Set(ignored);
  return findLooseEnds({ files, read: (file) => contents.get(file) ?? null }).filter((end) => !skip.has(looseEndKey(end)));
}

export function registerLooseEndsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_LOOSE_ENDS, async (_e, projectId: string): Promise<IPCResult<LooseEnd[]>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: await projectLooseEnds(project.path, project.settings.ignoredLooseEnds ?? [], getToolPath('git')) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
