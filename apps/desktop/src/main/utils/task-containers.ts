/**
 * Agents start databases, with the project's compose file or docker run, and leave them
 * behind. When the task's folder goes, so does what ran from it. Compose labels each
 * container with the folder it started from, the app labels what docker run starts, and
 * only exact matches are touched: the machine runs other people's containers too. Never
 * throws: a task must still get cleaned up when Docker is off. No Electron imports.
 */

import { basename, sep } from 'node:path';

import { type DockerRun, hostDocker } from '../ai/verification/test-services';

const PROJECT_LABEL = 'com.docker.compose.project';
const FOLDER_LABEL = 'com.docker.compose.project.working_dir';
const TASK_LABEL = 'vibe-teamlead.task-folder';

/** docker run at the start of a command, not the words anywhere: a grep for them must stay as it is */
const DOCKER_RUN = /(^|[;&|(\n]\s*)((?:\S*\/)?docker\s+(?:container\s+)?run)(?=\s)/g;

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** The project name compose gives a folder. Pure. */
export function composeProjectName(folder: string): string {
  return basename(folder).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** A Bash command that marks each container it starts as this task's. Pure. */
export function labelDockerRuns(command: string, folder: string): string {
  const value = `${TASK_LABEL}=${folder}`.replace(/'/g, `'\\''`);
  return command.replace(DOCKER_RUN, (_, before: string, run: string) => `${before}${run} --label '${value}'`);
}

export async function removeTaskContainers(worktreePath: string, docker: DockerRun = hostDocker(process.env)): Promise<void> {
  try {
    const listed = await docker(['ps', '-a', '--format', `{{.ID}}\t{{.Label "${FOLDER_LABEL}"}}\t{{.Label "${TASK_LABEL}"}}`]);
    if (!listed.ok) return;
    const ours = lines(listed.stdout)
      .map((line) => line.split('\t'))
      .filter(([, folder, task]) => [folder, task].some((from) => from === worktreePath || from?.startsWith(`${worktreePath}${sep}`)));
    for (const [id] of ours) await docker(['rm', '-f', '-v', id]);

    // By the name compose gives this folder: spec ids are unique, and these outlive their containers
    const filter = `label=${PROJECT_LABEL}=${composeProjectName(worktreePath)}`;
    for (const volume of lines((await docker(['volume', 'ls', '-q', '--filter', filter])).stdout)) await docker(['volume', 'rm', volume]);
    for (const network of lines((await docker(['network', 'ls', '-q', '--filter', filter])).stdout)) await docker(['network', 'rm', network]);
  } catch {
    // Non-fatal: leftovers cost disk, and the task's own cleanup must go on
  }
}
