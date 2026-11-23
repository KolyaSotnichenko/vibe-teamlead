/**
 * Dev servers the app runs for agents. Agents used to start them from Bash and
 * lost a lot of a session to it: a port already taken, `kill` hitting a wrapper
 * and leaving node behind, sleep-and-curl until it answers, starting over in the
 * next session. Here a server gets a free port, runs in its own process group,
 * is ready when it returns, is reused by later sessions of the task, and is
 * stopped with the task. No Electron imports: the worker uses it.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { getPlatformKey } from '../../platform';
import { envValue, WINDOWS_HOST_ENV, withPath } from '../../platform/env';
import { findOnPath, killTree, runProcess, searchPath, shellCommand } from '../../platform/exec';
import { writeFileReplacingSync } from '../safe-write';

export interface StartOptions {
  name: string;
  /** Shell command, run in `cwd`; `{port}` in it becomes the port */
  command: string;
  cwd: string;
  /** Holds the logs and the list of running servers */
  specDir: string;
  /** Wanted port; another one is used if it is taken */
  port?: number;
  /** Variable the port is passed in */
  portEnv?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Called when the server's process exits on its own after it was started; not when it is stopped here */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface StartResult {
  url: string;
  port: number;
  logPath: string;
  reused: boolean;
}

interface Server {
  name: string;
  /** What was asked for: a different request restarts the server */
  signature: string;
  pid: number;
  /** Start time from `ps` ('' on Windows): tells this process from a later one with the same pid */
  startedAt: string;
  port: number;
  logPath: string;
  specDir: string;
  child?: ChildProcess;
}

const isTaskWorktree = (dir: string) => dir.includes(`${sep}.vibe-teamlead${sep}worktrees${sep}`);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LISTED = 50;
const running = new Map<string, Server>();
const cleaned = new Set<string>();

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(500);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PlatformKey = 'darwin' | 'win32' | 'linux';

/**
 * How the servers' processes are told apart and stopped. macOS and Linux: a
 * process group, its start time from `ps`. Windows has neither groups nor ps:
 * the process itself, killTree (taskkill /T /F), no start time.
 */
export function devServerProcess(platform: PlatformKey) {
  const windows = platform === 'win32';
  const startedAt = (pid: number): string => {
    if (windows) return '';
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(windows ? pid : -pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (pid: number, name: NodeJS.Signals): void => {
    if (windows) {
      killTree(pid, name, platform);
      return;
    }
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone
    }
  };
  return { windows, startedAt, alive, signal };
}

type DevServerProcess = ReturnType<typeof devServerProcess>;

const host = devServerProcess(getPlatformKey());

/**
 * On Windows only a server whose own process still runs: once it has exited,
 * Windows may have given its pid to another process, and taskkill /T /F would
 * take that one and its children. Elsewhere the group, which can outlive the wrapper.
 */
const mayStop = (server: Pick<Server, 'child'>, proc: DevServerProcess) =>
  !proc.windows || (!!server.child && server.child.exitCode === null && server.child.signalCode === null);

export async function stopServerProcess(server: Pick<Server, 'pid' | 'child'>, proc: DevServerProcess = host): Promise<void> {
  const { pid } = server;
  if (!mayStop(server, proc)) return;
  proc.signal(pid, 'SIGTERM');
  for (let i = 0; i < 20 && proc.alive(pid); i++) await sleep(100);
  if (proc.alive(pid) && mayStop(server, proc)) {
    proc.signal(pid, 'SIGKILL');
    for (let i = 0; i < 10 && proc.alive(pid); i++) await sleep(100);
  }
}

const listFile = (specDir: string) => join(specDir, 'dev-servers', 'servers.json');

function saveList(specDir: string): void {
  try {
    const list = [...running.values()]
      .filter((s) => s.specDir === specDir)
      .map(({ name, pid, startedAt, port, logPath }) => ({ name, pid, startedAt, port, logPath }));
    writeFileReplacingSync(listFile(specDir), JSON.stringify(list, null, 2), 'utf-8');
  } catch {
    // The list only helps clean up after a killed run
  }
}

/** Working folder of a process, or '' when it can't be told. */
function processCwd(pid: number): string {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf-8' });
    return /^n(.+)$/m.exec(out)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * The task's own folder: the worktree a spec directory sits in. In the main project
 * only the spec directory: the project also holds the user's processes and other tasks.
 */
function taskRoot(specDir: string): string {
  const marker = `${sep}.vibe-teamlead${sep}specs${sep}`;
  const at = specDir.lastIndexOf(marker);
  const worktree = at > 0 ? specDir.slice(0, at) : '';
  const root = isTaskWorktree(worktree) ? worktree : specDir;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Stop servers a killed run left behind. Agents can write to this list and pids
 * get reused, so a listed pid is only signalled if it is still the same process
 * (ps start time) and lsof shows it runs in this task's folder. Windows has no
 * such check, so there a leftover is never killed, only logged: an agent could
 * list any process. Best effort: never throws.
 */
export function cleanUpLeftovers(
  specDir: string,
  platform: PlatformKey = getPlatformKey(),
  log: (line: string) => void = (line) => console.warn(`[dev-servers] ${line}`),
): void {
  let list: unknown;
  try {
    list = JSON.parse(readFileSync(listFile(specDir), 'utf-8'));
  } catch {
    return;
  }
  const root = taskRoot(specDir);
  const proc = devServerProcess(platform);
  for (const entry of Array.isArray(list) ? list.slice(0, MAX_LISTED) : []) {
    const { pid, startedAt } = (entry ?? {}) as { pid?: unknown; startedAt?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) continue;
    if (proc.windows) {
      log(`a dev server of an earlier run (pid ${pid}) was left running: on Windows the app can't confirm the pid is still that server`);
      continue;
    }
    if (typeof startedAt !== 'string' || !startedAt) continue;
    if (proc.startedAt(pid) !== startedAt) continue;
    const cwd = processCwd(pid);
    if (cwd === root || cwd.startsWith(`${root}${sep}`)) proc.signal(pid, 'SIGKILL');
  }
  try {
    writeFileReplacingSync(listFile(specDir), '[]', 'utf-8');
  } catch {
    // Same as above
  }
}

function logTail(path: string): string {
  try {
    return readFileSync(path, 'utf-8').split('\n').slice(-30).join('\n').trim();
  } catch {
    return '';
  }
}

/** The server's environment: what tools need, without the session's credentials. */
export function serverEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: searchPath(), HOME: process.env.HOME ?? homedir(), FORCE_COLOR: '0' };
  for (const key of ['USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', ...WINDOWS_HOST_ENV]) {
    const value = envValue(process.env, key);
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}

/** The folder of logs and the list, after a crashed run's leftovers are gone (they may hold the port wanted) */
function prepareFolder(specDir: string): string {
  const folder = join(specDir, 'dev-servers');
  mkdirSync(folder, { recursive: true });
  if (!cleaned.has(specDir)) {
    cleaned.add(specDir);
    cleanUpLeftovers(specDir);
  }
  return folder;
}

/** Starts a command in its own process group, logged and listed; the list lets a crashed run's leftovers be cleaned up. */
function spawnServer(o: { name: string; signature: string; command: string; cwd: string; specDir: string; port: number; env: Record<string, string>; onExit?: StartOptions['onExit'] }): { child: ChildProcess; logPath: string } {
  const folder = prepareFolder(o.specDir);
  const logPath = join(folder, `${o.name}.log`);
  const log = openSync(logPath, 'w');
  const shell = shellCommand(o.command);
  const child = spawn(shell.file, shell.args, {
    cwd: o.cwd,
    // its own process group: stopping it reaches whatever it started (killTree on Windows)
    detached: getPlatformKey() !== 'win32',
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: serverEnv(o.env),
  });
  closeSync(log);
  child.once('error', () => {});
  child.unref();

  const pid = child.pid;
  if (!pid) throw new Error(`Could not start ${o.name}`);
  const server: Server = { name: o.name, signature: o.signature, pid, startedAt: host.startedAt(pid), port: o.port, logPath, specDir: o.specDir, child };
  running.set(o.name, server);
  saveList(o.specDir);
  child.once('exit', (code, signal) => {
    if (running.get(o.name) === server) o.onExit?.(code, signal);
  });
  return { child, logPath };
}

export interface AppProcessOptions {
  name: string;
  /** Shell command, run in `cwd` */
  command: string;
  cwd: string;
  /** Holds the log and the list of running processes */
  specDir: string;
  env?: Record<string, string>;
  /** How long it must keep running to count as started (default 4000) */
  settleMs?: number;
  /** Called when its process ends on its own after it started (the owner closed the window); not when it is stopped here */
  onExit?: StartOptions['onExit'];
}

/**
 * A process that opens no port: an app with a window of its own (Electron, Tauri,
 * Flutter, .NET). Same group, log, list and `onExit` as a dev server; it counts as
 * started once it has kept running for `settleMs`. `stopDevServer` stops it.
 */
export async function startAppProcess(options: AppProcessOptions): Promise<{ logPath: string; reused: boolean }> {
  const { name, command, cwd, specDir, env = {}, settleMs = 4000 } = options;
  const signature = JSON.stringify({ app: true, command, cwd, env, specDir });
  const existing = running.get(name);
  if (existing) {
    if (existing.signature === signature && existing.child?.exitCode === null && existing.child.signalCode === null) return { logPath: existing.logPath, reused: true };
    await stopDevServer(name);
  }
  // Ending before it settled is a failed start, said by the throw below, not an exit after it started
  let started = false;
  const { child, logPath } = spawnServer({ name, signature, command, cwd, specDir, port: 0, env, onExit: (code, signal) => { if (started) options.onExit?.(code, signal); } });
  const ended = new Promise<void>((resolveEnd) => child.once('exit', () => resolveEnd()));
  const settled = await Promise.race([ended.then(() => false), sleep(settleMs).then(() => true)]);
  if (!settled) {
    await stopDevServer(name);
    throw new Error(`${name} exited as it started. Log (${logPath}):\n${logTail(logPath)}`);
  }
  started = true;
  return { logPath, reused: false };
}

export async function startDevServer(options: StartOptions): Promise<StartResult> {
  const { name, command, cwd, specDir, portEnv = 'PORT', env = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const signature = JSON.stringify({ command, cwd, portEnv, env, specDir });

  const existing = running.get(name);
  if (existing) {
    if (existing.signature === signature && existing.child?.exitCode === null && existing.child.signalCode === null) {
      return { url: `http://localhost:${existing.port}`, port: existing.port, logPath: existing.logPath, reused: true };
    }
    await stopDevServer(name);
  }

  prepareFolder(specDir);
  const port = options.port && (await portFree(options.port)) ? options.port : await anyFreePort();
  const { child, logPath } = spawnServer({ name, signature, command: command.replaceAll('{port}', String(port)), cwd, specDir, port, env: { ...env, [portEnv]: String(port) }, onExit: options.onExit });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      // A wrapper may exit while what it started keeps going, so the port decides
      if (!(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'))) {
        await stopDevServer(name);
        throw new Error(`${name} exited before listening on port ${port}. Log (${logPath}):\n${logTail(logPath)}`);
      }
    }
    if ((await answers(port, '127.0.0.1')) || (await answers(port, '::1'))) {
      return { url: `http://localhost:${port}`, port, logPath, reused: false };
    }
    await sleep(250);
  }

  await stopDevServer(name);
  throw new Error(
    `${name} did not listen on port ${port} within ${Math.round(timeoutMs / 1000)}s. If it doesn't read ${portEnv}, name the right variable in port_env or put {port} in the command. Log (${logPath}):\n${logTail(logPath)}`,
  );
}

export async function stopDevServer(name: string): Promise<boolean> {
  const server = running.get(name);
  if (!server) return false;
  running.delete(name);
  await stopServerProcess(server);
  saveList(server.specDir);
  return true;
}

export async function stopAllDevServers(): Promise<void> {
  await Promise.all([...running.keys()].map((name) => stopDevServer(name)));
}

/** For an abort, when there may be no time left to wait. */
export function killAllDevServersNow(): void {
  for (const server of running.values()) if (mayStop(server, host)) host.signal(server.pid, 'SIGTERM');
}

/**
 * A command that starts a dev server: these belong to start_dev_server, not Bash.
 * Only the package-manager form and known servers, and only as a command, not
 * as text in a grep. Pure — tested directly.
 */
export function isDevServerCommand(command: string): boolean {
  const start = String.raw`(?:^|[;&|(]\s*|\bexec\s+|\bnohup\s+|\benv\s+\S+\s+|\b[A-Z_]+=\S+\s+)`;
  const script = String.raw`(?:npm|pnpm|yarn|bun)\b[^;&|]*?\s(?:run\s+)?(?:dev|start:dev|serve)(?![\w:-])`;
  const known = String.raw`(?:(?:pnpm|npx|yarn)\s+(?:exec\s+)?)?(?:next\s+dev|nest\s+start|vite(?:\s+dev)?(?=\s*(?:$|[;&|]))|storybook\s+dev)`;
  return new RegExp(`${start}\\s*(?:${script}|${known})`).test(command.trim());
}

/** Containers a task worktree started, from `docker ps` lines of "<id> <compose working dir>". Pure. */
export function containersOfWorktree(ps: string, worktree: string): string[] {
  // Never the user's own containers: only a folder the app created for a task
  if (!isTaskWorktree(worktree)) return [];
  const ids: string[] = [];
  for (const line of ps.split('\n')) {
    const [id, dir] = line.trim().split(/\s+/, 2);
    if (id && dir && (dir === worktree || dir.startsWith(`${worktree}${sep}`))) ids.push(id);
  }
  return ids;
}

/**
 * Stop the containers a task started (not remove: `docker compose up` brings them
 * back with their data), so they don't hold ports for the next task.
 */
export async function stopWorktreeContainers(worktree: string): Promise<void> {
  if (!isTaskWorktree(worktree)) return;
  const docker = findOnPath('docker', searchPath());
  if (!docker || !existsSync(worktree)) return;
  const env = withPath(process.env, searchPath());
  const ps = await runProcess(
    docker,
    ['ps', '--filter', 'label=com.docker.compose.project', '--format', '{{.ID}} {{.Label "com.docker.compose.project.working_dir"}}'],
    { env, timeoutMs: 15_000 },
  );
  if (ps.code !== 0) return;
  const ids = containersOfWorktree(ps.stdout, worktree);
  if (ids.length) await runProcess(docker, ['stop', '-t', '5', ...ids], { env, timeoutMs: 60_000 });
}
