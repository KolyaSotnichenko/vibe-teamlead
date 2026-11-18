/**
 * One preview at a time: the main branch's worktree, its dependencies, the
 * workspace packages the services use, the preview database, the compose file's
 * other services (queues, storage, search…, throwaway for the session), migrations,
 * a seed on a fresh database, then the services, backends first and the page last.
 * Leaving the view stops all of it. A stop aborts what is running, and the next
 * start waits until the stopped one has finished, so two never share a database
 * volume or a worktree. A stopped session reports nothing after its "stopped".
 * No Electron imports.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import type { PreviewAddressIssue, PreviewEnvReport, PreviewEnvVar, PreviewStatus } from '../../shared/types/preview';
import type { Project, PreviewService } from '../../shared/types/project';
import { cleanUpLeftovers, serverEnv, startDevServer, stopDevServer } from '../ai/dev-servers/dev-servers';
import { onMergeSettled } from '../ai/merge/merge-queue';
import { type ComposeRun, startComposeServices } from '../ai/verification/compose-runner';
import { bucketsOf, type ComposeService, composeServices } from '../ai/verification/compose-services';
import { composeFilesInOrder, detectChecks, imagesFromComposeFiles } from '../ai/verification/detect-checks';
import { examplePort, previewAddressesByExamplePort } from './example-urls';
import { baseEnvVars, envOf, exampleTexts, serviceEnvVars } from './preview-env';
import { type DisplacedPorts, findHardcodedAddresses, proxiedPaths } from './hardcoded-addresses';
import { localPortFree } from './preview-ports';
import { probeThroughPage, type ProbeResult } from './probe';
import { type DockerRun, hostDocker } from '../ai/verification/test-services';
import { needsInstall, packageManagerOf } from '../design/storybook-service';
import { findOnPath, runProcess, runShell, searchPath } from '../platform/exec';
import { workspaceLibraries } from './detect-services';
import { frameworkMigrations, migratesOnLocalFile, stackInstalls } from './stacks';
import { PREVIEW_LABEL, type PreviewDatabase, previewTaskKey, removeTaskPreviewVolumes, startPreviewDatabase } from './preview-database';
import { needsMail, type PreviewMail, startPreviewMail } from './preview-mail';
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
  /** The compose file's other services (queues, storage, search…), throwaway for the session */
  startCompose: typeof startComposeServices;
  runCommand: (command: string, cwd: string, env: Record<string, string>, signal: AbortSignal) => Promise<{ code: number; output: string }>;
  startServer: (options: Parameters<typeof startDevServer>[0]) => ReturnType<typeof startDevServer>;
  stopServer: (name: string) => Promise<boolean>;
  /** A service's log file as text, or null when it can't be read */
  readLog: (path: string) => string | null;
  cleanUpLeftovers: (specDir: string) => void;
  /** A local mail catcher, when the project's example settings configure SMTP */
  startMail: (docker: DockerRun, key: string) => Promise<PreviewMail>;
  /** Writes a small file in the worktree (what was installed, so it isn't installed again) */
  writeFile: (root: string, path: string, text: string) => void;
  /** A free local port, picked before any service starts so each can name the others' URLs */
  pickPort: () => Promise<number>;
  /** Whether nothing listens on this local port (127.0.0.1 and ::1), so a service can have the port it expects */
  portFree: (port: number) => Promise<boolean>;
  /** One request through the running page, to see whether what it proxies answers */
  probe: (url: string) => Promise<ProbeResult>;
}

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const TAIL_CHARS = 2000;
const SERVER_START_TIMEOUT_MS = 180_000;

/** A task's preview: its worktree as it is, on a copy of the project's preview data */
export interface PreviewTask {
  taskId: string;
  worktree: string;
}

interface Session {
  project: Project;
  task?: PreviewTask;
  deps: PreviewDeps;
  onStatus: (status: PreviewStatus) => void;
  abort: AbortController;
  worktree: string;
  servers: string[];
  /** Where each running service logs, by service name */
  logs: Record<string, string>;
  /** What each started service got, by service name, for the Environment panel */
  vars: Record<string, PreviewEnvVar[]>;
  database?: PreviewDatabase;
  /** The database kinds compose names, started or not */
  databaseKinds: string[];
  /** The compose file's other services, started or not */
  composePlanned: ComposeService[];
  compose?: ComposeRun;
  /** Whether the examples configure SMTP */
  mailWanted: boolean;
  mail?: PreviewMail;
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

/** The real dependencies; exported for tests. */
export function defaultPreviewDeps(): Omit<PreviewDeps, 'git' | 'secretsDir' | 'worktreesRoot'> {
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
    startCompose: startComposeServices,
    startMail: startPreviewMail,
    writeFile: (root, path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text, 'utf-8');
    },
    runCommand: async (command, cwd, env, signal) => {
      const result = await runShell(command, { cwd, env: previewCommandEnv(env), signal, timeoutMs: COMMAND_TIMEOUT_MS, killGroup: true });
      return { code: result.code, output: `${result.stdout}${result.stderr}` };
    },
    startServer: startDevServer,
    stopServer: stopDevServer,
    readLog: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    },
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
    portFree: localPortFree,
    probe: probeThroughPage,
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

/**
 * The variables of one folder, with their sources (preview-env.ts): its and the root's
 * `.env.example`, the database, the mail catcher, the owner's preview settings. Never `.env`.
 * An example's connection setting the preview has no database for is set empty, so the app
 * can't fall back to a real one.
 */
function varsFor(session: Session, dir: string, files: string[]): PreviewEnvVar[] {
  return baseEnvVars({
    dir,
    ...exampleTexts(files, (path) => session.deps.read(session.worktree, path), dir),
    started: session.database?.status === 'started' ? session.database.started : [],
    compose: { planned: session.composePlanned, started: session.compose?.started ?? [] },
    mailPort: session.mail?.status === 'started' ? session.mail.smtpPort : undefined,
    overrides: session.project.settings.previewEnv,
  });
}

function envFor(session: Session, dir: string, files: string[]): Record<string, string> {
  return envOf(varsFor(session, dir, files));
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

/**
 * Migrations, only ever on the preview's own database: the project's (Prisma, Drizzle) on its
 * SQL database, and each service folder's framework migrations (Django, Alembic, Rails,
 * Laravel) also when compose names no database, as those default to a local file. Returns
 * whether a SQL database is there, for the seed.
 */
async function runMigrations(session: Session, files: string[], report: boolean): Promise<boolean> {
  const database = session.database;
  if (!database || database.status === 'unavailable') return false;
  const sql = database.status === 'started' && database.started.some((s) => s.kind === 'postgres' || s.kind === 'mysql');
  const project = { files, read: (p: string) => session.deps.read(session.worktree, p) };
  const commands: Array<{ dir: string; command: string }> = [];
  const add = (dir: string, command: string) => {
    if (!commands.some((c) => c.dir === dir && c.command === command)) commands.push({ dir, command });
  };
  if (sql) for (const command of detectChecks(project).prepare ?? []) add('', command);
  // With the preview's SQL database, on it; without a database in compose, only onto a local file
  for (const dir of serviceDirs(session)) {
    for (const command of frameworkMigrations(project, dir)) {
      if (sql || (database.status === 'none' && migratesOnLocalFile(project, dir, command))) add(dir, command);
    }
  }
  if (commands.length && report) emit(session, { stage: 'migrations' });
  for (const { dir, command } of commands) {
    const result = await session.deps.runCommand(command, resolve(session.worktree, dir), envFor(session, dir, files), session.abort.signal);
    check(session);
    if (result.code !== 0) throw Object.assign(new Error('The migrations failed'), { logTail: tail(result.output) });
  }
  return sql;
}

/** The root and every service's folder */
function serviceDirs(session: Session): string[] {
  return [...new Set(['', ...(session.project.settings.previewServices ?? []).map((s) => s.dir)])];
}

/** Where a folder's install is recorded, relative to the worktree */
const installStampPath = (dir: string) => `.vibe-teamlead/specs/preview/installed-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`;

/**
 * Python, Ruby, PHP and Go dependencies of the root and the services' folders, each with its
 * own tool. A folder is installed again only when its command or its lockfiles changed.
 */
async function installStacks(session: Session, files: string[]): Promise<void> {
  const read = (p: string) => session.deps.read(session.worktree, p);
  for (const install of stackInstalls({ files, read }, serviceDirs(session))) {
    const stamp = createHash('sha256').update([install.command, ...install.lockfiles.map((f) => `${f}\0${read(f) ?? ''}`)].join('\0')).digest('hex');
    const stampPath = installStampPath(`${install.dir}\0${install.command}`);
    if (read(stampPath) === stamp) continue;
    emit(session, { stage: 'install', message: `${install.dir || '.'}: ${install.command}` });
    const result = await session.deps.runCommand(install.command, resolve(session.worktree, install.dir), envFor(session, install.dir, files), session.abort.signal);
    check(session);
    if (result.code !== 0) {
      throw Object.assign(new Error(`The dependencies in ${install.dir || 'the project root'} did not install`), { logTail: tail(result.output) });
    }
    session.deps.writeFile(session.worktree, stampPath, stamp);
  }
}

/** Node dependencies at the root, when the project has a package.json to install from */
async function installNode(session: Session, files: string[], lockfileChanged: boolean): Promise<void> {
  if (!files.includes('package.json') || !(lockfileChanged || session.deps.needsInstall(session.worktree))) return;
  emit(session, { stage: 'install', message: undefined });
  await session.deps.install(session.worktree, (line) => emit(session, { stage: 'install', message: line }), session.abort.signal);
  check(session);
}

interface StartedServices {
  url: string;
  /** Addresses the project hard-codes for a service the preview runs on another port */
  issues: PreviewAddressIssue[];
}

/**
 * Each service on the port the project expects it on (its example, its dev script, its
 * framework's default) when that port is free, so addresses the project hard-codes still
 * work; a free port of the preview's choosing otherwise.
 */
async function choosePort(session: Session, expected: number | undefined, taken: number[]): Promise<number> {
  if (expected && !taken.includes(expected) && (await session.deps.portFree(expected))) return expected;
  let port = await session.deps.pickPort();
  while (taken.includes(port)) port = await session.deps.pickPort();
  return port;
}

async function startServices(session: Session, files: string[]): Promise<StartedServices> {
  const services = session.project.settings.previewServices ?? [];
  const ordered = [...services.filter((s) => !s.page), ...services.filter((s) => s.page)];
  const read = (path: string) => session.deps.read(session.worktree, path);
  // Every port first: a backend may need the page's URL (CORS), and the page starts last
  const ports: Record<string, number> = {};
  const urls: Record<string, string> = {};
  const expected: Record<string, number | undefined> = {};
  for (const service of ordered) {
    expected[service.name] = examplePort(service, read);
    const port = await choosePort(session, expected[service.name], Object.values(ports));
    ports[service.name] = port;
    urls[service.name] = `http://localhost:${port}`;
  }
  // Local addresses in the examples point at each service's preview port; urlEnv still wins
  const byExamplePort = previewAddressesByExamplePort(ordered, urls, read);
  let pageUrl = '';
  const displaced: DisplacedPorts = {};
  emit(session, { stage: 'services' });
  for (const service of ordered) {
    check(session);
    const vars = serviceEnvVars(varsFor(session, service.dir, files), {
      byExamplePort,
      urlEnv: service.urlEnv,
      urls,
      serviceOverrides: session.project.settings.previewServiceEnv?.[service.name],
      portEnv: service.portEnv ?? 'PORT',
      port: ports[service.name],
    });
    const env = envOf(vars);
    const name = serverName(service);
    session.servers.push(name);
    let started;
    let actualPort = ports[service.name];
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
        onExit: () => void serviceExited(session, service.name, name, actualPort),
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
    actualPort = started.port;
    session.vars[service.name] = vars.map((v) => (v.source === 'port' ? { ...v, value: String(started.port) } : v));
    urls[service.name] = started.url;
    session.logs[service.name] = started.logPath;
    if (service.page) pageUrl = started.url;
    const own = expected[service.name];
    if (own && started.port !== own) displaced[service.name] = { ownPort: own, previewPort: started.port };
  }
  return { url: pageUrl, issues: findHardcodedAddresses(ordered, { files, read }, displaced) };
}

const LOG_LINES = 30;

/**
 * A service's process ended on its own. Before "ready" start-up reports it; after, the preview
 * fails like a start-up failure does, naming the service with the end of its log. A stop by the
 * app or the owner is not this (the session is over or its servers are already taken off the list),
 * and a wrapper that exited while its service still answers on the port is not either.
 */
async function serviceExited(session: Session, service: string, name: string, port: number | undefined): Promise<void> {
  const listening = () => session.servers.includes(name) && session.status.stage === 'ready' && current === session && !cancelled(session);
  if (!listening()) return;
  const logPath = session.logs[service];
  if (port !== undefined && !(await session.deps.portFree(port))) return;
  // The check took time: a stop or a restart may have happened meanwhile
  if (!listening()) return;
  const log = (logPath ? session.deps.readLog(logPath) : null) ?? '';
  const logTail = tail(log.split('\n').slice(-LOG_LINES).join('\n').trim());
  await teardown(session);
  failed(session, Object.assign(new Error(`${service} stopped`), { logTail, stoppedService: service }));
}

const UNREACHABLE_STATUS = new Set([502, 504]);
const UNREACHABLE_ERROR = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH']);

/**
 * When nothing explains it yet: a request through the page to what it proxies. A 502
 * or a 504, or a refused connection, means the page can't reach a backend, and the owner is
 * told so instead of looking at a blank page. Runs after "ready", never holds it up.
 */
async function checkReachable(session: Session, url: string, files: string[]): Promise<void> {
  const services = session.project.settings.previewServices ?? [];
  const page = services.find((s) => s.page);
  if (!page || !url) return;
  const backends = services.filter((s) => !s.page);
  const read = (path: string) => session.deps.read(session.worktree, path);
  for (const path of proxiedPaths(page, { files, read })) {
    const result = await session.deps.probe(`${url}${path}`);
    // A newer start or a stop has taken over
    if (cancelled(session) || session.status.url !== url || session.status.stage !== 'ready') return;
    const failure = result.status !== undefined ? (UNREACHABLE_STATUS.has(result.status) ? String(result.status) : '') : UNREACHABLE_ERROR.has(result.error ?? '') ? (result.error ?? '') : '';
    if (!failure) continue;
    const issue: PreviewAddressIssue = { ...(backends.length === 1 ? { service: backends[0].name } : {}), unreachable: { path, result: failure } };
    emit(session, { addressIssues: [issue] });
    return;
  }
}

/** Ready with the page's URL; the reachability check follows when the scan found nothing */
function ready(session: Session, started: StartedServices, files: string[]): void {
  emit(session, { stage: 'ready', url: started.url, origins: [new URL(started.url).origin], message: undefined, logTail: undefined, addressIssues: started.issues });
  if (!started.issues.length) void checkReachable(session, started.url, files).catch(() => {});
}

async function stopServers(session: Session): Promise<void> {
  for (const name of session.servers.splice(0).reverse()) await session.deps.stopServer(name);
}

async function teardown(session: Session): Promise<void> {
  session.unsubscribe();
  const database = session.database;
  const mail = session.mail;
  const compose = session.compose;
  session.database = undefined;
  session.mail = undefined;
  session.compose = undefined;
  await Promise.all([stopServers(session), database?.stop(), mail?.stop(), compose?.stop()]);
}

function failed(session: Session, error: unknown): PreviewStatus {
  const message = error instanceof Error ? error.message : String(error);
  const { logTail, stoppedService } = error as { logTail?: string; stoppedService?: string };
  emit(session, { stage: 'failed', message, logTail, stoppedService, url: undefined, origins: [] });
  if (current === session) current = null;
  return session.status;
}

async function run(session: Session, resetData: boolean): Promise<PreviewStatus> {
  const { project, deps } = session;
  try {
    emit(session, { stage: 'worktree' });
    // A task's worktree is the agents': it is shown as it is, never moved
    const synced = session.task
      ? Promise.resolve({ lockfileChanged: false })
      : deps.sync(project.path, project.settings.mainBranch ?? 'main', deps.git, session.worktree);
    await synced.then(async ({ lockfileChanged }) => {
      check(session);
      deps.cleanUpLeftovers(previewSpecDir(session.worktree));
      const files = await deps.listFiles(session.worktree);
      check(session);

      await installNode(session, files, lockfileChanged);
      await installStacks(session, files);

      await buildLibraries(session, files, true);

      emit(session, { stage: 'database', message: undefined });
      // The main compose file first; an override can add a kind the main file doesn't name
      const composeContents = composeFilesInOrder(files).map((file) => deps.read(session.worktree, file) ?? '');
      const images = imagesFromComposeFiles(composeContents);
      session.databaseKinds = images.map((image) => image.kind);
      const database = await deps.startDatabase(images, {
        docker: deps.docker,
        projectId: session.task ? previewTaskKey(session.task.worktree) : project.id,
        ...(session.task ? { copyFrom: project.id } : {}),
        secretsDir: deps.secretsDir,
        reset: resetData,
        signal: session.abort.signal,
      });
      session.database = database;
      check(session);
      emit(session, { database: database.status, databaseReason: database.reason });

      const examples = [...new Set(['', ...(project.settings.previewServices ?? []).map((s) => s.dir)])]
        .map((dir) => (dir ? `${dir}/.env.example` : '.env.example'))
        .filter((path) => files.includes(path))
        .map((path) => deps.read(session.worktree, path) ?? '')
        .join('\n');
      const key = session.task ? previewTaskKey(session.task.worktree) : project.id;

      // The compose file's other services, after the database: its start clears the label's leftovers
      session.composePlanned = composeServices(composeContents);
      if (session.composePlanned.length) {
        emit(session, { stage: 'database', message: session.composePlanned.map((s) => s.name).join(', ') });
        const compose = await deps.startCompose(session.composePlanned, {
          docker: deps.docker, labelKey: PREVIEW_LABEL, labelValue: key, buckets: bucketsOf(examples), signal: session.abort.signal, pickPort: deps.pickPort,
        });
        session.compose = compose;
        check(session);
        const notices = compose.failed.length ? compose.failed.map((f) => f.reason) : compose.status === 'unavailable' && compose.reason ? [compose.reason] : [];
        emit(session, { message: undefined, ...(compose.status === 'none' ? {} : { services: compose.status }), ...(notices.length ? { servicesNotices: notices } : {}) });
      }

      // The app's mail goes to a local catcher, when its example settings configure SMTP
      session.mailWanted = needsMail(examples);
      if (session.mailWanted) {
        session.mail = await deps.startMail(deps.docker, key);
        check(session);
        emit(session, { mail: session.mail.status, mailReason: session.mail.reason });
      }

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

      ready(session, await startServices(session, files), files);
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
      await installNode(session, files, true);
      await installStacks(session, files);
      await buildLibraries(session, files, true);
      await runMigrations(session, files, true);
      ready(session, await startServices(session, files), files);
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
  options: { resetData?: boolean; task?: PreviewTask } = {},
): Promise<PreviewStatus> {
  await stopPreview();
  // A stopped session may still be winding down: it must be gone before this one touches the worktree or the volume
  await Promise.allSettled([...unfinished]);
  const services = project.settings.previewServices ?? [];
  if (services.filter((s) => s.page).length !== 1) {
    const status: PreviewStatus = { projectId: project.id, ...(options.task ? { taskId: options.task.taskId } : {}), stage: 'failed', origins: [], message: 'Choose exactly one service whose page the preview shows.' };
    onStatus(status);
    return status;
  }
  const session: Session = {
    project,
    deps: { ...defaultPreviewDeps(), ...deps },
    onStatus,
    abort: new AbortController(),
    task: options.task,
    worktree: options.task?.worktree ?? previewWorktreePath(deps.worktreesRoot, project.id),
    servers: [],
    logs: {},
    vars: {},
    databaseKinds: [],
    composePlanned: [],
    mailWanted: false,
    status: { projectId: project.id, ...(options.task ? { taskId: options.task.taskId } : {}), stage: 'worktree', origins: [] },
    unsubscribe: () => {},
    work: Promise.resolve(),
    mergePending: false,
  };
  const projectDir = resolve(project.path);
  session.unsubscribe = onMergeSettled((dir) => {
    if (session.task || resolve(dir) !== projectDir) return;
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

/**
 * A task's worktree is being removed (merged, discarded, deleted): its preview stops and its
 * copy of the preview data goes. The project's own preview is left running.
 */
export async function releaseTaskPreview(
  worktree: string,
  removeVolumes: (worktree: string) => Promise<void> = (path) => removeTaskPreviewVolumes(hostDocker(process.env), path),
): Promise<void> {
  const session = current;
  if (session?.task && resolve(session.task.worktree) === resolve(worktree)) {
    await stopPreview();
    // Only that session's own work must be over before its volumes go; the project's preview may still be starting
    await Promise.allSettled([session.work]);
  }
  await removeVolumes(worktree).catch(() => {});
}

/**
 * Restarts the running preview's services with the project's current settings (the owner's
 * new values); the database, mail catcher and worktree stay. Null when that preview isn't
 * running and ready, so the caller starts it instead.
 */
export async function restartPreviewServices(project: Project, taskId?: string): Promise<PreviewStatus | null> {
  const session = current;
  if (!session || session.project.id !== project.id || session.task?.taskId !== taskId || session.status.stage !== 'ready') return null;
  session.project = project;
  const work = session.work.then(async () => {
    if (cancelled(session)) return;
    try {
      const files = await session.deps.listFiles(session.worktree);
      check(session);
      emit(session, { stage: 'services', url: undefined, origins: [], addressIssues: undefined, message: undefined });
      await stopServers(session);
      session.vars = {};
      ready(session, await startServices(session, files), files);
    } catch (error) {
      if (error instanceof Cancelled || cancelled(session)) return;
      await teardown(session);
      failed(session, error);
    }
  });
  session.work = work;
  await work;
  return session.status;
}

const overridesOf = (project: Project) => JSON.stringify([project.settings.previewEnv ?? {}, project.settings.previewServiceEnv ?? {}]);

/**
 * What the running preview's services got, when this preview (the project's, or that task's)
 * is ready; null otherwise, and the caller works out what they will get. `project` is the
 * saved one: values saved since the start ask for a restart.
 */
export function runningPreviewEnv(project: Project, taskId?: string): PreviewEnvReport | null {
  const session = current;
  if (!session || session.project.id !== project.id || session.task?.taskId !== taskId || session.status.stage !== 'ready') return null;
  return {
    running: true,
    restartNeeded: overridesOf(project) !== overridesOf(session.project),
    databases: session.databaseKinds,
    composeServices: session.composePlanned.map((service) => service.name),
    mail: session.mailWanted,
    // Compose services that all failed for their own reasons aren't Docker's absence
    dockerUnavailable: session.database?.status === 'unavailable' || session.mail?.status === 'unavailable' || (session.compose?.status === 'unavailable' && !session.compose.failed.length),
    services: (session.project.settings.previewServices ?? []).map((service) => ({ service: service.name, dir: service.dir, vars: session.vars[service.name] ?? [] })),
  };
}

/** Where the running preview's services log, for the Logs panel */
export function previewLogs(projectId: string): Array<{ service: string; path: string }> {
  if (!current || current.project.id !== projectId) return [];
  return Object.entries(current.logs).map(([service, path]) => ({ service, path }));
}

/** The running preview's mail catcher web port, when it has one */
export function previewMailPort(projectId: string): number | undefined {
  return current?.project.id === projectId && current.mail?.status === 'started' ? current.mail.httpPort : undefined;
}

export function currentPreview(): PreviewStatus | null {
  return current?.status ?? null;
}
