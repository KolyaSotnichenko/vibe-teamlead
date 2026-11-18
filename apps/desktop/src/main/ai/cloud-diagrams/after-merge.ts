/**
 * After a merge into the project: when the setting is on and the merge changed
 * Terraform, redraw the cloud architecture from code (redraw.ts). Fire and forget
 * from the merge handler: it never blocks, fails or slows the merge. One redraw per
 * project at a time; a later merge waits for the one before.
 */

import { join } from 'node:path';

import { findOnPath, runProcess } from '../../platform/exec';
import { getPlatformKey } from '../../platform';
import { gitRunner } from '../merge/git-merge';
import { isCloudDiagramsEnabled } from './cloud-setting';
import { type CloudArchitectureMeta, redrawCloudArchitecture, type RedrawDeps } from './redraw';
import { detectCloudTools } from './terravision';

/** Where the latest drawing from code lives (.vibe-teamlead is kept out of the project's git). */
export function cloudArchitectureDir(projectPath: string): string {
  return join(projectPath, '.vibe-teamlead', 'cloud-architecture');
}

export interface AfterMergeDeps {
  enabled: () => boolean;
  git: RedrawDeps['git'];
  redraw: (input: Parameters<typeof redrawCloudArchitecture>[0]) => Promise<CloudArchitectureMeta | undefined>;
}

const flights = new Map<string, Promise<unknown>>();

export function defaultAfterMergeDeps(projectPath: string, git: string, gitEnv: NodeJS.ProcessEnv): AfterMergeDeps {
  const run = gitRunner(projectPath, git, gitEnv);
  return {
    enabled: isCloudDiagramsEnabled,
    git: run,
    redraw: (input) =>
      redrawCloudArchitecture(input, {
        git: run,
        run: runProcess,
        tools: detectCloudTools((name) => findOnPath(name)),
        platform: getPlatformKey(),
        hostEnv: process.env,
      }),
  };
}

export async function cloudRedrawAfterMerge(
  input: { projectPath: string; baseBranch: string; taskId?: string; taskTitle?: string },
  deps: AfterMergeDeps,
): Promise<CloudArchitectureMeta | undefined> {
  try {
    if (!deps.enabled()) return undefined;
    const base = input.baseBranch.replace(/^origin\//, '');
    const commit = (await deps.git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).stdout;
    if (!commit) return undefined;
    // The merge commit's first parent is the base before the merge: the rest is what the task brought
    const diff = await deps.git(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', `${commit}^1`, commit]);
    const changedFiles = diff.raw.split('\0').filter(Boolean);
    const before = flights.get(input.projectPath) ?? Promise.resolve();
    const flight = before.catch(() => undefined).then(() =>
      deps.redraw({ projectDir: input.projectPath, commit, changedFiles, storeDir: cloudArchitectureDir(input.projectPath), taskId: input.taskId, taskTitle: input.taskTitle }),
    );
    flights.set(input.projectPath, flight);
    try {
      return await flight;
    } finally {
      if (flights.get(input.projectPath) === flight) flights.delete(input.projectPath);
    }
  } catch {
    return undefined;
  }
}
