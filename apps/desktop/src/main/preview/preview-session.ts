/**
 * One preview at a time: the main branch's worktree, its dependencies, the
 * workspace packages the services use, the preview database, migrations, a seed
 * on a fresh database, then the services, backends first and the page last.
 * Leaving the view stops all of it. A stop aborts what is running, and the next
 * start waits until the stopped one has finished, so two never share a database
 * volume or a worktree. A stopped session reports nothing after its "stopped".
 * No Electron imports.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import type { PreviewStatus } from '../../shared/types/preview';
import type { Project, PreviewService } from '../../shared/types/project';
import { cleanUpLeftovers, serverEnv, startDevServer, stopDevServer } from '../ai/dev-servers/dev-servers';
import { onMergeSettled } from '../ai/merge/merge-queue';
import { detectChecks, serviceEnv, serviceImages } from '../ai/verification/detect-checks';
import { previewAddressesByExamplePort, rewriteExampleUrls } from './example-urls';
import { type DockerRun, hostDocker } from '../ai/verification/test-services';
import { needsInstall, packageManagerOf } from '../design/storybook-service';
import { findOnPath, runProcess, searchPath } from '../platform/exec';
import { workspaceLibraries } from './detect-services';
import { type PreviewDatabase, startPreviewDatabase } from './preview-database';
import { previewSpecDir, previewWorktreePath, syncPreviewWorktree } from './preview-worktree';

export type { PreviewStage, PreviewStatus } from '../../shared/types/preview';

export interface PreviewDeps {
  git: string;
  docker: DockerRun;
  /** The app's data folder for preview secrets */
  secretsDir: string;
  /** Where the previews' worktrees live, outside every project (…/.vibe-teamlead/worktrees/preview) */
  worktreesRoot: string;
  sync: typeof syncPreviewWorktree;
  /** Tracked files of the worktree, with `/` */
  listFiles: (root: string) => string[] | Promise<string[]>;
  read: (root: string, path: string) => string | null;
  needsInstall: (root: string) => boolean;
  install: (root: string, onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  startDatabase: typeof startPreviewDatabase;
  runCommand: (command: string, cwd: string, env: Record<string, string>, signal: AbortSignal) => Promise<{ code: number; output: string }>;
  startServer: (options: Parameters<typeof startDevServer>[0]) => ReturnType<typeof startDevServer>;
  stopServer: (name: string) => Promise<boolean>;
  cleanUpLeftovers: (specDir: string) => void;
  /** A free local port, picked before any service starts so each can name the others' URLs */
  pickPort: () => Promise<number>;
}

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const TAIL_CHARS = 2000;
const SERVER_START_TIMEOUT_MS = 180_000;

interface Session {
  project: Project;
  deps: PreviewDeps;
  onStatus: (status: PreviewStatus) => void;
  abort: AbortController;
  worktree: string;
  servers: string[];
  database?: PreviewDatabase;
  status: PreviewStatus;
  unsubscribe: () => void;
  /** The start, then each re-sync after a merge, one after another */
  work: Promise<unknown>;
  /** A merge settled before the preview was ready */
  mergePending: boolean;
}

let current: Session | null = null;
/** Every session not yet finished, current or stopped: the next start waits for them */
const unfinished = new Set<Promise<unknown>>();

const serverName = (service: PreviewService) => `preview-${service.name}`;
const tail = (text: string) => text.slice(-TAIL_CHARS);
const cancelled = (session: Session) => session.abort.signal.aborted;

class Cancelled extends Error {}

/** What a preview's commands run with: what tools need plus the preview's variables, never the app's own environment. */
export function previewCommandEnv(env: Record<string, string>): Record<string, string> {
  return serverEnv(env);
}

function defaultDeps(): Omit<PreviewDeps, 'git' | 'secretsDir' | 'worktreesRoot'> {
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
    install: async (root, onLine, signal) => {
      const pm = packageManagerOf(root);
      onLine(`${pm} install`);
      const result = await runProcess(findOnPath(pm, searchPath()) ?? pm, ['install'], {
        cwd: root, env: previewCommandEnv({ CI: '1' }), signal, killGroup: true, timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: (line) => line.trim() && onLine(line.trim().slice(0, 200)),
      });
      if (result.aborted) throw new Cancelled();
      if (result.code !== 0) throw Object.assign(new Error(`${pm} install failed`), { logTail: tail(`${result.stdout}${result.stderr}`) });
    },
    startDatabase: startPreviewDatabase,
    runCommand: async (command, cwd, env, signal) => {
      const result = await runProcess('/bin/sh', ['-c', command], { cwd, env: previewCommandEnv(env), signal, timeoutMs: COMMAND_TIMEOUT_MS, killGroup: true });
      return { code: result.code, output: `${result.stdout}${result.stderr}` };
    },
    startServer: startDevServer,
    stopServer: stopDevServer,
    cleanUpLeftovers,
    pickPort: () =>
      new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          server.close(() => resolvePort(port));
        });
      }),
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

/** A stopped session is silent: stopPreview has already said "stopped" for it. */
function emit(session: Session, patch: Partial<PreviewStatus>): void {
  if (cancelled(session)) return;
  session.status = { ...session.status, ...patch };
  session.onStatus(session.status);
}

function check(session: Session): void {
  if (cancelled(session)) throw new Cancelled();
}

const exampleKeys = (text: string) =>
  text.split('\n').map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]).filter((key): key is string => !!key);

/**
 * The variables of one folder: its and the root's `.env.example`, the database, the
 * owner's preview settings. Never `.env`. An example's connection setting the preview
 * has no database for is set empty, so the app can't fall back to a real one.
 */
function envFor(session: Session, dir: string, files: string[]): Record<string, string> {
  const root = session.worktree;
  const started = session.database?.status === 'started' ? session.database.started : [];
  const examples = ['.env.example', ...(dir ? [`${dir}/.env.example`] : [])]
    .filter((path) => files.includes(path))
    .map((path) => session.deps.read(root, path) ?? '')
    .join('\n');
  const env = serviceEnv(examples, started);
  for (const key of exampleKeys(examples)) if (!(key in env)) env[key] = '';
  return { ...env, ...(session.project.settings.previewEnv ?? {}) };
}

/** The workspace packages the services use from built output: a fresh worktree has no dist/ for them. */
async function buildLibraries(session: Session, files: string[], report: boolean): Promise<void> {
  const root = session.worktree;
  const read = (p: string) => session.deps.read(root, p);
  for (const library of workspaceLibraries({ files, read }, session.project.settings.previewServices ?? [])) {
    if (report) emit(session, { stage: 'libraries', message: library.name });
    const result = await session.deps.runCommand(library.command, resolve(root, library.dir), envFor(session, library.dir, files), session.abort.signal);
    check(session);
    if (result.code !== 0) throw Object.assign(new Error(`${library.name} did not build`), { logTail: tail(result.output) });
  }
}

/** Migrations, only ever on the preview's own SQL database. */
async function runMigrations(session: Session, files: string[], report: boolean): Promise<boolean> {
  const database = session.database;
  if (!(database?.status === 'started' && database.started.some((s) => s.kind === 'postgres' || s.kind === 'mysql'))) return false;
  const read = (p: string) => session.deps.read(session.worktree, p);
  const prepare = detectChecks({ files, read }).prepare ?? [];
  if (prepare.length && report) emit(session, { stage: 'migrations' });
  for (const command of prepare) {
    const result = await session.deps.runCommand(command, session.worktree, envFor(session, '', files), session.abort.signal);
    check(session);
    if (result.code !== 0) throw Object.assign(new Error('The migrations failed'), { logTail: tail(result.output) });
  }
  return true;
}

async function startServices(session: Session, files: string[]): Promise<string> {
  const services = session.project.settings.previewServices ?? [];
  const ordered = [...services.filter((s) => !s.page), ...services.filter((s) => s.page)];
  // Every port first: a backend may need the page's URL (CORS), and the page starts last
  const ports: Record<string, number> = {};
  const urls: Record<string, string> = {};
  for (const service of ordered) {
    let port = await session.deps.pickPort();
    while (Object.values(ports).includes(port)) port = await session.deps.pickPort();
    ports[service.name] = port;
    urls[service.name] = `http://localhost:${port}`;
  }
  // Local addresses in the examples point at each service's preview port; urlEnv still wins
  const byExamplePort = previewAddressesByExamplePort(ordered, urls, (path) => session.deps.read(session.worktree, path));
  let pageUrl = '';
  emit(session, { stage: 'services' });
  for (const service of ordered) {
    check(session);
    const env = rewriteExampleUrls(envFor(session, service.dir, files), byExamplePort);
    for (const [variable, other] of Object.entries(service.urlEnv ?? {})) if (urls[other]) env[variable] = urls[other];
    const name = serverName(service);
    session.servers.push(name);
    let started;
    try {
      started = await session.deps.startServer({
        name,
        command: service.command,
        cwd: resolve(session.worktree, service.dir),
        specDir: previewSpecDir(session.worktree),
        port: ports[service.name],
        portEnv: service.portEnv ?? 'PORT',
        env,
        timeoutMs: SERVER_START_TIMEOUT_MS,
      });
    } catch (error) {
      if (cancelled(session)) throw new Cancelled();
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`${service.name} did not start`), { logTail: tail(message) });
    }
    // A stop while it was starting found nothing to stop yet
    if (cancelled(session)) {
      await session.deps.stopServer(name);
      throw new Cancelled();
    }
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
  const database = session.database;
  session.database = undefined;
  await Promise.all([stopServers(session), database?.stop()]);
}

function failed(session: Session, error: unknown): PreviewStatus {
  const message = error instanceof Error ? error.message : String(error);
  emit(session, { stage: 'failed', message, logTail: (error as { logTail?: string }).logTail, url: undefined, origins: [] });
  if (current === session) current = null;
  return session.status;
}

async function run(session: Session, resetData: boolean): Promise<PreviewStatus> {
  const { project, deps } = session;
  try {
    emit(session, { stage: 'worktree' });
    await deps.sync(project.path, project.settings.mainBranch ?? 'main', deps.git, session.worktree).then(async ({ lockfileChanged }) => {
      check(session);
      deps.cleanUpLeftovers(previewSpecDir(session.worktree));
      const files = await deps.listFiles(session.worktree);
      check(session);

      if (lockfileChanged || deps.needsInstall(session.worktree)) {
        emit(session, { stage: 'install' });
        await deps.install(session.worktree, (line) => emit(session, { stage: 'install', message: line }), session.abort.signal);
        check(session);
      }

      await buildLibraries(session, files, true);

      emit(session, { stage: 'database', message: undefined });
      const compose = files.find((file) => /^(docker-)?compose\.ya?ml$/.test(file));
      const images = compose ? serviceImages(deps.read(session.worktree, compose) ?? '') : [];
      const database = await deps.startDatabase(images, { docker: deps.docker, projectId: project.id, secretsDir: deps.secretsDir, reset: resetData, signal: session.abort.signal });
      session.database = database;
      check(session);
      emit(session, { database: database.status, databaseReason: database.reason });

      const sql = await runMigrations(session, files, true);
      if (sql && session.database?.fresh) {
        const manager = managerOf(files);
        const dirs = ['', ...(project.settings.previewServices ?? []).map((s) => s.dir)];
        for (const dir of [...new Set(dirs)]) {
          const command = seedCommand(deps.read(session.worktree, dir ? `${dir}/package.json` : 'package.json'), manager);
          if (!command) continue;
          emit(session, { stage: 'seed' });
          const result = await deps.runCommand(command, resolve(session.worktree, dir), envFor(session, dir, files), session.abort.signal);
          check(session);
          if (result.code !== 0) throw Object.assign(new Error('The seed failed'), { logTail: tail(result.output) });
          break;
        }
      }

      const url = await startServices(session, files);
      emit(session, { stage: 'ready', url, origins: [new URL(url).origin], message: undefined, logTail: undefined });
    });
    if (session.mergePending) {
      session.mergePending = false;
      session.work = session.work.then(() => afterMerge(session));
    }
    return session.status;
  } catch (error) {
    await teardown(session);
    if (error instanceof Cancelled || cancelled(session)) return session.status;
    return failed(session, error);
  }
}

/**
 * After a merge into the previewed project's main: move the worktree, rebuild the
 * workspace packages and apply new migrations; a new lockfile also reinstalls and
 * restarts the services. Hot reload covers the rest.
 */
async function afterMerge(session: Session): Promise<void> {
  if (cancelled(session)) return;
  if (session.status.stage !== 'ready') {
    session.mergePending = true;
    return;
  }
  try {
    const { lockfileChanged, moved } = await session.deps.sync(session.project.path, session.project.settings.mainBranch ?? 'main', session.deps.git, session.worktree);
    check(session);
    if (!moved) return;
    const files = await session.deps.listFiles(session.worktree);
    check(session);
    if (lockfileChanged) {
      emit(session, { stage: 'install', message: undefined });
      await stopServers(session);
      await session.deps.install(session.worktree, (line) => emit(session, { stage: 'install', message: line }), session.abort.signal);
      check(session);
      await buildLibraries(session, files, true);
      await runMigrations(session, files, true);
      const url = await startServices(session, files);
      emit(session, { stage: 'ready', url, origins: [new URL(url).origin], message: undefined });
    } else {
      await buildLibraries(session, files, false);
      await runMigrations(session, files, false);
    }
  } catch (error) {
    if (error instanceof Cancelled || cancelled(session)) return;
    await teardown(session);
    failed(session, error);
  }
}

export async function startPreview(
  project: Project,
  onStatus: (status: PreviewStatus) => void,
  deps: Partial<PreviewDeps> & Pick<PreviewDeps, 'git' | 'secretsDir' | 'worktreesRoot'>,
  options: { resetData?: boolean } = {},
): Promise<PreviewStatus> {
  await stopPreview();
  // A stopped session may still be winding down: it must be gone before this one touches the worktree or the volume
  await Promise.allSettled([...unfinished]);
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
    abort: new AbortController(),
    worktree: previewWorktreePath(deps.worktreesRoot, project.id),
    servers: [],
    status: { projectId: project.id, stage: 'worktree', origins: [] },
    unsubscribe: () => {},
    work: Promise.resolve(),
    mergePending: false,
  };
  const projectDir = resolve(project.path);
  session.unsubscribe = onMergeSettled((dir) => {
    if (resolve(dir) !== projectDir) return;
    session.work = session.work.then(() => afterMerge(session));
  });
  current = session;
  const started = run(session, options.resetData === true);
  session.work = started;
  const tracked = started.finally(() => unfinished.delete(tracked));
  unfinished.add(tracked);
  return started;
}

/** Stop the running preview, or only this project's when an id is given. Aborts whatever it was running. */
export async function stopPreview(projectId?: string): Promise<void> {
  const session = current;
  if (!session || (projectId && session.project.id !== projectId)) return;
  current = null;
  session.status = { ...session.status, stage: 'stopped', url: undefined, origins: [] };
  session.abort.abort();
  session.onStatus(session.status);
  await teardown(session);
}

export function currentPreview(): PreviewStatus | null {
  return current?.status ?? null;
}
