/**
 * What "set up for CI" means, and the one-time cleanup of what the old Vercel deploy left in userData.
 *
 * A project is set up once the GitHub repository step is done: `settings.deploy.repo` is recorded.
 * Projects set up under the old Deploy (`enabled` + `repo` + a Vercel project) count too; their
 * stale Vercel fields are ignored. `enabled` without a repository never counts.
 */
import { rm as fsRm } from 'node:fs/promises';
import path from 'node:path';

import type { Project } from '../../shared/types';

export function isCiSetUp(project: { settings?: Pick<Project['settings'], 'deploy'> } | undefined | null): boolean {
  return !!project?.settings?.deploy?.repo;
}

/** userData entries the Vercel deploy created (credential, downloaded CLI, link folders). Nothing else is touched. */
export const VERCEL_LEFTOVERS = ['vercel-credential.json', 'vercel-cli', 'vercel-link'] as const;

export interface CleanupDeps {
  rm(target: string, options: { recursive: true; force: true }): Promise<unknown>;
}

/** Removes the Vercel leftovers in `userData`. Best effort: a missing path or any failure is ignored; never throws. */
export async function cleanupVercelLeftovers(userData: string, deps: CleanupDeps = { rm: fsRm }): Promise<void> {
  if (!userData) return;
  for (const name of VERCEL_LEFTOVERS) {
    try {
      await deps.rm(path.join(userData, name), { recursive: true, force: true });
    } catch {
      // permission error or the like: leave it
    }
  }
}
