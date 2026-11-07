/**
 * One preview at a time: the main branch's worktree, its dependencies, the
 * preview database, migrations, a seed on a fresh database, then the services,
 * backends first and the page last. Leaving the view stops all of it. A stop
 * while starting wins: whatever finishes starting after it is stopped too, and
 * the session never reports ready. No Electron imports.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Project, PreviewService } from '../../shared/types/project';
import { cleanUpLeftovers, startDevServer, stopDevServer } from '../ai/dev-servers/dev-servers';
import { onMergeSettled } from '../ai/merge/merge-queue';
import { detectChecks, serviceEnv, serviceImages } from '../ai/verification/detect-checks';
import { type DockerRun, hostDocker } from '../ai/verification/test-services';
import { installDependencies, needsInstall } from '../design/storybook-service';
import { runProcess } from '../platform/exec';
import { type PreviewDatabase, startPreviewDatabase } from './preview-database';
import { previewSpecDir, syncPreviewWorktree } from './preview-worktree';

export type PreviewStage = 'worktree' | 'install' | 'database' | 'migrations' | 'seed' | 'services' | 'ready' | 'failed' | 'stopped';

export interface PreviewStatus {
  projectId: string;
  stage: PreviewStage;
  url?: string;
  /** Where the view may navigate */
  origins: string[];
  message?: string;
  logTail?: string;
  database?: PreviewDatabase['status'];
  databaseReason?: string;
}

export interface PreviewDeps {
  git: string;
  docker: DockerRun;
  /** The app's data folder for preview secrets */
  secretsDir: string;
  sync: typeof syncPreviewWorktree;
  /** Tracked files of the worktree, with `/` */
  listFiles: (root: string) => string[] | Promise<string[]>;
  read: (root: string, path: string) => string | null;
  needsInstall: (root: string) => boolean;
  install: (root: string, onLine?: (line: string) => void) => Promise<void>;
  startDatabase: typeof startPreviewDatabase;
  runCommand: (command: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; output: string }>;
  startServer: (options: Parameters<typeof startDevServer>[0]) => ReturnType<typeof startDevServer>;
  stopServer: (name: string) => Promise<boolean>;
  cleanUpLeftovers: (specDir: string) => void;
}

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const TAIL_CHARS = 2000;
const SERVER_START_TIMEOUT_MS = 180_000;

interface Session {
  project: Project;
  deps: PreviewDeps;
  onStatus: (status: PreviewStatus) => void;
  cancelled: boolean;
  worktree?: string;
  servers: string[];
  database?: PreviewDatabase;
  status: PreviewStatus;
  unsubscribe: () => void;
  /** Re-syncs after merges run one at a time */
  resync: Promise<void>;
}

let current: Session | null = null;

const serverName = (service: PreviewService) => `preview-${service.name}`;
const tail = (text: string) => text.slice(-TAIL_CHARS);

class Cancelled extends Error {}

function defaultDeps(): Omit<PreviewDeps, 'git' | 'secretsDir'> {
  return {
    docker: hostDocker(process.env),
    sync: syncPreviewWorktree,
    listFiles: async (root) => {
      const result = await runProcess('git', ['ls-files', '-z'], { cwd: root, timeoutMs: 60_000 });
      return result.code === 0 ? result.stdout.split('\0').filter(Boolean) : [];
    },
    read: (root, path) => {
      try {
        return readFileSync(join(root, path), 'utf-8');
      } catch {
        return null;
      }
    },
    needsInstall: (root) => needsInstall(root, ''),
    install: installDependencies,
    startDatabase: startPreviewDatabase,
    runCommand: async (command, cwd, env) => {
      const result = await runProcess('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...env }, timeoutMs: COMMAND_TIMEOUT_MS, killGroup: true });
      return { code: result.code, output: `${result.stdout}${result.stderr}` };
    },
    startServer: startDevServer,
    stopServer: stopDevServer,
    cleanUpLeftovers,
  };
}

/** The seed command of a package: `db:seed`, `seed`, or Prisma's configured seed. */
function seedCommand(packageJson: string | null, manager: string): string | null {
  try {
    const parsed = JSON.parse(packageJson ?? '') as { scripts?: Record<string, string>; prisma?: { seed?: string } };
    if (parsed.scripts?.['db:seed']) return `${manager} run db:seed`;
    if (parsed.scripts?.seed) return `${manager} run seed`;
    if (parsed.prisma?.seed) return `${manager === 'npm' ? 'npx' : `${manager} exec`} prisma db seed`;
  } catch {
    // no package.json
  }
  return null;
}

function managerOf(files: string[]): string {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun';
  return 'npm';
}

function emit(session: Session, patch: Partial<PreviewStatus>): void {
  if (session.cancelled && patch.stage !== 'stopped') return;
  session.status = { ...session.status, ...patch };
  session.onStatus(session.status);
}

function check(session: Session): void {
  if (session.cancelled) throw new Cancelled();
}

/** The variables of one folder: its and the root's `.env.example`, the database, the owner's preview settings. Never `.env`. */
function envFor(session: Session, dir: string, files: string[]): Record<string, string> {
  const root = session.worktree!;
  const started = session.database?.status === 'started' ? session.database.started : [];
  const examples = ['.env.example', ...(dir ? [`${dir}/.env.example`] : [])]
    .filter((path) => files.includes(path))
    .map((path) => session.deps.read(root, path) ?? '')
    .join('\n');
  return { ...serviceEnv(examples, started), ...(session.project.settings.previewEnv ?? {}) };
}

async function startServices(session: Session, files: string[]): Promise<string> {
  const services = session.project.settings.previewServices ?? [];
  const ordered = [...services.filter((s) => !s.page), ...services.filter((s) => s.page)];
  const urls: Record<string, string> = {};
  let pageUrl = '';
  emit(session, { stage: 'services' });
  for (const service of ordered) {
    check(session);
    const env = envFor(session, service.dir, files);
    for (const [variable, other] of Object.entries(service.urlEnv ?? {})) if (urls[other]) env[variable] = urls[other];
    const name = serverName(service);
    session.servers.push(name);
    let started;
    try {
      started = await session.deps.startServer({
        name,
        command: service.command,
        cwd: resolve(session.worktree!, service.dir),
        specDir: previewSpecDir(session.worktree!),
        portEnv: service.portEnv ?? 'PORT',
        env,
        timeoutMs: SERVER_START_TIMEOUT_MS,
      });
    } catch (error) {
      if (session.cancelled) throw new Cancelled();
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`${service.name} did not start`), { logTail: tail(message) });
    }
    check(session);
    urls[service.name] = started.url;
    if (service.page) pageUrl = started.url;
  }
  return pageUrl;
}

async function stopServers(session: Session): Promise<void> {
  for (const name of session.servers.splice(0).reverse()) await session.deps.stopServer(name);
}

async function teardown(session: Session): Promise<void> {
  session.unsubscribe();
  await stopServers(session);
  const database = session.database;
  session.database = undefined;
  await database?.stop();
}

async function run(session: Session, resetData: boolean): Promise<PreviewStatus> {
  const { project, deps } = session;
  try {
    emit(session, { stage: 'worktree' });
    const { path, lockfileChanged } = await deps.sync(project.path, project.settings.mainBranch ?? 'main', deps.git);
    session.worktree = path;
    check(session);
    deps.cleanUpLeftovers(previewSpecDir(path));
    const files = await deps.listFiles(path);
    check(session);

    if (lockfileChanged || deps.needsInstall(path)) {
      emit(session, { stage: 'install' });
      await deps.install(path, (line) => emit(session, { stage: 'install', message: line }));
      check(session);
    }

    emit(session, { stage: 'database', message: undefined });
    const compose = files.find((file) => /^(docker-)?compose\.ya?ml$/.test(file));
    const images = compose ? serviceImages(deps.read(path, compose) ?? '') : [];
    const database = await deps.startDatabase(images, { docker: deps.docker, projectId: project.id, secretsDir: deps.secretsDir, reset: resetData });
    session.database = database;
    check(session);
    emit(session, { database: database.status, databaseReason: database.reason });

    const sql = database.status === 'started' && database.started.some((s) => s.kind === 'postgres' || s.kind === 'mysql');
    if (sql) {
      const read = (p: string) => deps.read(path, p);
      const prepare = detectChecks({ files, read }).prepare ?? [];
      if (prepare.length) emit(session, { stage: 'migrations' });
      for (const command of prepare) {
        const result = await deps.runCommand(command, path, envFor(session, '', files));
        check(session);
        if (result.code !== 0) throw Object.assign(new Error('The migrations failed'), { logTail: tail(result.output) });
      }
    }

    if (sql && database.fresh) {
      const manager = managerOf(files);
      const dirs = ['', ...(project.settings.previewServices ?? []).map((s) => s.dir)];
      for (const dir of [...new Set(dirs)]) {
        const command = seedCommand(deps.read(path, dir ? `${dir}/package.json` : 'package.json'), manager);
        if (!command) continue;
        emit(session, { stage: 'seed' });
        const result = await deps.runCommand(command, resolve(path, dir), envFor(session, dir, files));
        check(session);
        if (result.code !== 0) throw Object.assign(new Error('The seed failed'), { logTail: tail(result.output) });
        break;
      }
    }

    const url = await startServices(session, files);
    emit(session, { stage: 'ready', url, origins: [new URL(url).origin], message: undefined, logTail: undefined });
    return session.status;
  } catch (error) {
    await teardown(session);
    if (error instanceof Cancelled || session.cancelled) {
      emit(session, { stage: 'stopped' });
      return session.status;
    }
    const message = error instanceof Error ? error.message : String(error);
    const logTail = (error as { logTail?: string }).logTail;
    emit(session, { stage: 'failed', message, logTail, url: undefined, origins: [] });
    if (current === session) current = null;
    return session.status;
  }
}

/** After a merge into the previewed project's main: move the worktree; on a new lockfile, install and restart the services. */
async function afterMerge(session: Session): Promise<void> {
  if (session.cancelled || session.status.stage !== 'ready') return;
  try {
    const { lockfileChanged } = await session.deps.sync(session.project.path, session.project.settings.mainBranch ?? 'main', session.deps.git);
    if (!lockfileChanged || session.cancelled) return;
    emit(session, { stage: 'install' });
    await stopServers(session);
    await session.deps.install(session.worktree!, (line) => emit(session, { stage: 'install', message: line }));
    check(session);
    const url = await startServices(session, await session.deps.listFiles(session.worktree!));
    emit(session, { stage: 'ready', url, origins: [new URL(url).origin], message: undefined });
  } catch (error) {
    if (error instanceof Cancelled || session.cancelled) return;
    await teardown(session);
    emit(session, { stage: 'failed', message: error instanceof Error ? error.message : String(error), logTail: (error as { logTail?: string }).logTail, origins: [] });
    if (current === session) current = null;
  }
}

export async function startPreview(
  project: Project,
  onStatus: (status: PreviewStatus) => void,
  deps: Partial<PreviewDeps> & Pick<PreviewDeps, 'git' | 'secretsDir'>,
  options: { resetData?: boolean } = {},
): Promise<PreviewStatus> {
  await stopPreview();
  const services = project.settings.previewServices ?? [];
  if (services.filter((s) => s.page).length !== 1) {
    const status: PreviewStatus = { projectId: project.id, stage: 'failed', origins: [], message: 'Choose exactly one service whose page the preview shows.' };
    onStatus(status);
    return status;
  }
  const session: Session = {
    project,
    deps: { ...defaultDeps(), ...deps },
    onStatus,
    cancelled: false,
    servers: [],
    status: { projectId: project.id, stage: 'worktree', origins: [] },
    unsubscribe: () => {},
    resync: Promise.resolve(),
  };
  const projectDir = resolve(project.path);
  session.unsubscribe = onMergeSettled((dir) => {
    if (resolve(dir) !== projectDir) return;
    session.resync = session.resync.then(() => afterMerge(session));
  });
  current = session;
  return run(session, options.resetData === true);
}

/** Stop the running preview, or only this project's when an id is given. */
export async function stopPreview(projectId?: string): Promise<void> {
  const session = current;
  if (!session || (projectId && session.project.id !== projectId)) return;
  current = null;
  session.cancelled = true;
  await teardown(session);
  emit(session, { stage: 'stopped', url: undefined, origins: [] });
}

export function currentPreview(): PreviewStatus | null {
  return current?.status ?? null;
}
