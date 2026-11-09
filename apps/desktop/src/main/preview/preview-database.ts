/**
 * The Preview's database: the image the compose file names, as the app checks
 * start it, but on a named volume kept per project, so an account the owner
 * registered is still there next time. Its password lives in the app's own data,
 * never in the project. Nothing here ever points at a database the app didn't
 * start. No Electron imports.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileReplacingSync } from '../ai/safe-write';
import type { ServiceImage, StartedService } from '../ai/verification/detect-checks';
import { type DockerRun, dockerMissingReason, RECIPES } from '../ai/verification/test-services';

export const PREVIEW_LABEL = 'vibe-teamlead-preview';
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const REASON_CHARS = 200;

export interface PreviewDatabase {
  status: 'none' | 'started' | 'unavailable';
  started: StartedService[];
  /** The volume was created by this start: migrations ran on nothing yet, and a seed may run */
  fresh: boolean;
  reason?: string;
  stop(): Promise<void>;
}

export interface PreviewDatabaseOptions {
  docker: DockerRun;
  projectId: string;
  /** The app's own data folder for preview secrets */
  secretsDir: string;
  /** Start from an empty volume and a new password */
  reset?: boolean;
  /**
   * A task's preview: the project whose preview data a new volume starts as a copy of, so
   * the owner's account is there, while the task's migrations touch only the copy
   */
  copyFrom?: string;
  /** A stop: whatever started is removed and nothing more starts */
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export const previewVolume = (projectId: string, kind: ServiceImage['kind']) => `${PREVIEW_LABEL}-${projectId}-${kind}`;

/** The key of a task's preview data, from its worktree: plain enough for docker names */
export const previewTaskKey = (worktree: string) => `task-${createHash('sha256').update(worktree).digest('hex').slice(0, 12)}`;

/** A task's preview volumes, removed with its worktree */
export async function removeTaskPreviewVolumes(docker: DockerRun, worktree: string): Promise<void> {
  const prefix = `${PREVIEW_LABEL}-${previewTaskKey(worktree)}-`;
  const listed = await docker(['volume', 'ls', '-q', '--filter', `name=${prefix}`]);
  const volumes = listed.stdout.split('\n').map((v) => v.trim()).filter((v) => v.startsWith(prefix));
  if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
}

type Secrets = { passwords: Partial<Record<ServiceImage['kind'], string>> };

function readSecrets(file: string): Secrets {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Secrets;
    return parsed && typeof parsed.passwords === 'object' && parsed.passwords ? parsed : { passwords: {} };
  } catch {
    return { passwords: {} };
  }
}

export async function startPreviewDatabase(images: ServiceImage[], options: PreviewDatabaseOptions): Promise<PreviewDatabase> {
  const { docker, projectId, secretsDir, reset = false, copyFrom, signal, readyTimeoutMs = READY_TIMEOUT_MS, pollMs = POLL_MS } = options;
  const nothing = async () => {};
  if (!images.length) return { status: 'none', started: [], fresh: false, stop: nothing };
  if (!(await docker(['info'])).ok) {
    return { status: 'unavailable', started: [], fresh: false, reason: dockerMissingReason(images, 'app', 'to see it with its data'), stop: nothing };
  }

  const label = `${PREVIEW_LABEL}=${projectId}`;
  for (const id of (await docker(['ps', '-aq', '--filter', `label=${label}`])).stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    await docker(['rm', '-f', id]);
  }

  mkdirSync(secretsDir, { recursive: true });
  const secretsFile = join(secretsDir, `${projectId}.json`);
  const secrets = readSecrets(secretsFile);

  const ids: string[] = [];
  const stop = async () => {
    for (const id of ids.splice(0)) await docker(['rm', '-f', id]);
  };
  const gaveUp = async (reason: string): Promise<PreviewDatabase> => {
    await stop();
    return { status: 'unavailable', started: [], fresh: false, reason, stop: nothing };
  };

  const started: StartedService[] = [];
  let fresh = false;
  for (const { kind, image } of images) {
    const recipe = RECIPES[kind];
    const volume = previewVolume(projectId, kind);
    if (signal?.aborted) return gaveUp('The preview was stopped.');
    if (reset) {
      const removed = await docker(['volume', 'rm', '-f', volume]);
      // A new password for old data would lock every later open out
      if (!removed.ok) return gaveUp(`The preview's data could not be reset: ${removed.stdout.trim().slice(0, REASON_CHARS)}`);
      delete secrets.passwords[kind];
    }
    let existed = (await docker(['volume', 'inspect', volume])).ok;
    // A task's first open: its own copy of the project's preview data, with the password that data has
    if (!existed && copyFrom && (await docker(['volume', 'inspect', previewVolume(copyFrom, kind)])).ok) {
      const copied =
        (await docker(['volume', 'create', volume])).ok &&
        (await docker(['run', '--rm', '--entrypoint', 'sh', '-v', `${previewVolume(copyFrom, kind)}:/from:ro`, '-v', `${volume}:/to`, image, '-c', 'cp -a /from/. /to/'])).ok;
      const password = readSecrets(join(secretsDir, `${copyFrom}.json`)).passwords[kind];
      if (copied && password) {
        secrets.passwords[kind] = password;
        existed = true;
      } else {
        await docker(['volume', 'rm', '-f', volume]);
      }
    }
    if (!existed) fresh = true;
    // A volume made with another password won't accept a new one: keep the stored one while the volume lives
    const password = (existed && secrets.passwords[kind]) || randomBytes(16).toString('hex');
    secrets.passwords[kind] = password;
    writeFileReplacingSync(secretsFile, JSON.stringify(secrets, null, 2), 'utf-8');

    const run = await docker([
      'run', '-d', '--rm', '--label', label,
      ...recipe.env(password).flatMap((pair) => ['-e', pair]),
      '-v', `${volume}:${recipe.dataDir}`,
      '-p', `127.0.0.1::${recipe.port}`,
      image,
    ]);
    const id = run.stdout.trim().split('\n').pop() ?? '';
    if (!run.ok || !id) return gaveUp(`Docker could not start ${image}: ${run.stdout.trim().slice(0, REASON_CHARS)}`);
    ids.push(id);
    if (signal?.aborted) return gaveUp('The preview was stopped.');

    const port = (await docker(['port', id, `${recipe.port}/tcp`])).stdout.trim().split('\n')[0]?.split(':').pop() ?? '';
    if (!port) return gaveUp(`Docker gave no port for ${image}.`);

    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (signal?.aborted) return gaveUp('The preview was stopped.');
      ready = (await docker(['exec', id, ...recipe.ready(password)])).ok;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!ready) return gaveUp(`${image} did not get ready in time.`);
    started.push({ kind, url: recipe.url(password, port) });
  }
  return { status: 'started', started, fresh, stop };
}

/** Containers a crashed preview left behind. Volumes stay: they hold the owner's preview data. */
export async function removePreviewLeftovers(docker: DockerRun): Promise<void> {
  const ids = (await docker(['ps', '-aq', '--filter', `label=${PREVIEW_LABEL}`])).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const id of ids) await docker(['rm', '-f', id]);
}
