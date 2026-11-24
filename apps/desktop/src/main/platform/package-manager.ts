/**
 * Which package manager a folder uses, and whether its dependencies are installed. No Electron
 * imports: the agent worker uses these too.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** By the lockfile at `root` (npm when there is none) */
export function packageManagerOf(root: string): PackageManager {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Dependencies are missing when neither the folder `dir` nor the root has node_modules. */
export function needsInstall(root: string, dir: string): boolean {
  return !existsSync(path.join(root, dir, 'node_modules')) && !existsSync(path.join(root, 'node_modules'));
}
