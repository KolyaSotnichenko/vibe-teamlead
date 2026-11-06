/**
 * Throwaway databases for the app's checks. A project's compose file says which
 * database it uses, and only the image is taken from it: the file itself could mount
 * anything or ask for privileges. Each run gets its own empty database on a local
 * port, with a fresh password, so nobody has to set anything up and no task sees
 * another's data. No Electron imports.
 */

import { randomBytes } from 'node:crypto';

import { findOnPath, runProcess, searchPath } from '../../platform/exec';
import type { ServiceImage, StartedService } from './detect-checks';

export type DockerRun = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export interface TestServices {
  status: 'none' | 'started' | 'unavailable';
  started: StartedService[];
  /** Why they couldn't start, in words a user can act on */
  reason?: string;
  stop: () => Promise<void>;
}

const LABEL = 'vibe-teamlead-verify';
const USER = 'verify';
const PULL_TIMEOUT_MS = 10 * 60_000;
const REASON_CHARS = 200;

interface Recipe {
  port: number;
  env: (password: string) => string[];
  url: (password: string, port: string) => string;
  ready: (password: string) => string[];
}

const RECIPES: Record<ServiceImage['kind'], Recipe> = {
  postgres: {
    port: 5432,
    env: (password) => [`POSTGRES_USER=${USER}`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=${USER}`],
    url: (password, port) => `postgresql://${USER}:${password}@127.0.0.1:${port}/${USER}`,
    // Over TCP: while it initialises, the server only answers on its socket, and then restarts
    ready: () => ['pg_isready', '-h', '127.0.0.1', '-U', USER, '-d', USER],
  },
  mysql: {
    port: 3306,
    env: (password) => [`MYSQL_USER=${USER}`, `MYSQL_PASSWORD=${password}`, `MYSQL_DATABASE=${USER}`, 'MYSQL_RANDOM_ROOT_PASSWORD=1'],
    url: (password, port) => `mysql://${USER}:${password}@127.0.0.1:${port}/${USER}`,
    ready: (password) => ['sh', '-c', `mysqladmin ping -h 127.0.0.1 -u${USER} -p${password} || mariadb-admin ping -h 127.0.0.1 -u${USER} -p${password}`],
  },
  redis: {
    port: 6379,
    env: () => [],
    url: (_password, port) => `redis://127.0.0.1:${port}`,
    ready: () => ['sh', '-c', 'redis-cli ping || valkey-cli ping'],
  },
  mongo: {
    port: 27017,
    env: (password) => [`MONGO_INITDB_ROOT_USERNAME=${USER}`, `MONGO_INITDB_ROOT_PASSWORD=${password}`],
    url: (password, port) => `mongodb://${USER}:${password}@127.0.0.1:${port}/${USER}?authSource=admin`,
    ready: () => ['mongosh', '--quiet', '--eval', 'db.runCommand({ ping: 1 })'],
  },
};

/** docker as the machine has it. An app started from Finder has a bare PATH. */
export function hostDocker(env: NodeJS.ProcessEnv, signal?: AbortSignal): DockerRun {
  const bin = findOnPath('docker', searchPath()) ?? 'docker';
  return async (args) => {
    const result = await runProcess(bin, args, { env: { ...env, PATH: searchPath() }, signal, timeoutMs: PULL_TIMEOUT_MS });
    return { ok: result.code === 0, stdout: `${result.stdout}${result.code === 0 ? '' : result.stderr}` };
  };
}

export async function startTestServices(
  images: ServiceImage[],
  options: { docker: DockerRun; label: string; readyTimeoutMs?: number; pollMs?: number },
): Promise<TestServices> {
  const { docker, label, readyTimeoutMs = 60_000, pollMs = 500 } = options;
  const nothing = async () => {};
  if (!images.length) return { status: 'none', started: [], stop: nothing };

  if (!(await docker(['info'])).ok) {
    const needs = images.map((image) => image.kind).join(', ');
    return { status: 'unavailable', started: [], reason: `This project's tests need ${needs}, and Docker isn't running. Install or start Docker Desktop for a full check.`, stop: nothing };
  }

  // A run that died can't clean up after itself. Only this project's: a project runs one check at a time.
  const left = (await docker(['ps', '-aq', '--filter', `label=${LABEL}=${label}`])).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const id of left) await docker(['rm', '-f', '-v', id]);

  const ids: string[] = [];
  const stop = async () => {
    for (const id of ids.splice(0)) await docker(['rm', '-f', '-v', id]);
  };
  const gaveUp = async (reason: string): Promise<TestServices> => {
    await stop();
    return { status: 'unavailable', started: [], reason, stop: nothing };
  };

  const started: StartedService[] = [];
  for (const { kind, image } of images) {
    const recipe = RECIPES[kind];
    const password = randomBytes(16).toString('hex');
    const run = await docker(['run', '-d', '--rm', '--label', `${LABEL}=${label}`, ...recipe.env(password).flatMap((pair) => ['-e', pair]), '-p', `127.0.0.1::${recipe.port}`, image]);
    const id = run.stdout.trim().split('\n').pop() ?? '';
    if (!run.ok || !id) return gaveUp(`Docker could not start ${image}: ${run.stdout.trim().slice(0, REASON_CHARS)}`);
    ids.push(id);

    const port = (await docker(['port', id, `${recipe.port}/tcp`])).stdout.trim().split('\n')[0]?.split(':').pop() ?? '';
    if (!port) return gaveUp(`Docker gave no port for ${image}.`);

    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = (await docker(['exec', id, ...recipe.ready(password)])).ok;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!ready) return gaveUp(`${image} did not get ready in time.`);
    started.push({ kind, url: recipe.url(password, port) });
  }
  return { status: 'started', started, stop };
}
