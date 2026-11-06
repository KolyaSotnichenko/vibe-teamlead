/**
 * Agents start databases with the project's compose file, from the task's folder, and
 * leave them behind. When the task's folder goes, so does what ran from it. Compose
 * labels each container with the folder it started from, and only exact matches are
 * touched: the machine runs other people's containers too. Never throws: a task must
 * still get cleaned up when Docker is off. No Electron imports.
 */

import { basename, sep } from 'node:path';

import { type DockerRun, hostDocker } from '../ai/verification/test-services';

const PROJECT_LABEL = 'com.docker.compose.project';
const FOLDER_LABEL = 'com.docker.compose.project.working_dir';

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** The project name compose gives a folder. Pure. */
export function composeProjectName(folder: string): string {
  return basename(folder).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

export async function removeTaskContainers(worktreePath: string, docker: DockerRun = hostDocker(process.env)): Promise<void> {
  try {
    const listed = await docker(['ps', '-a', '--format', `{{.ID}}\t{{.Label "${FOLDER_LABEL}"}}`]);
    if (!listed.ok) return;
    const ours = lines(listed.stdout)
      .map((line) => line.split('\t'))
      .filter(([, folder]) => folder === worktreePath || folder?.startsWith(`${worktreePath}${sep}`));
    for (const [id] of ours) await docker(['rm', '-f', '-v', id]);

    // By the name compose gives this folder: spec ids are unique, and these outlive their containers
    const filter = `label=${PROJECT_LABEL}=${composeProjectName(worktreePath)}`;
    for (const volume of lines((await docker(['volume', 'ls', '-q', '--filter', filter])).stdout)) await docker(['volume', 'rm', volume]);
    for (const network of lines((await docker(['network', 'ls', '-q', '--filter', filter])).stdout)) await docker(['network', 'rm', network]);
  } catch {
    // Non-fatal: leftovers cost disk, and the task's own cleanup must go on
  }
}
