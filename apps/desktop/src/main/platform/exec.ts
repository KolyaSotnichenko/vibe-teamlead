/**
 * Running external tools (scanners, Docker, Strix, CodeGraph) from the main
 * process or a worker: one place for timeouts, abort, output limits and
 * finding executables when the app was started from Finder (minimal PATH),
 * plus the platform differences of running commands: the shell (Git Bash on
 * Windows), killing a process tree and .cmd shims. No Electron: the worker uses it.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, win32 } from 'node:path';

import { envValue, pathValue } from './env';
import { findGitBash } from './git-bash';
import { getPlatformKey } from './index';
import { getTaskkillExePath } from '../utils/windows-paths';

type PlatformKey = 'darwin' | 'win32' | 'linux';
type Exists = (file: string) => boolean;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this long (default 2 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Keep at most this many characters of stdout / stderr (default 16 MB). */
  maxOutput?: number;
  /** Run it in its own process group and kill the whole group (taskkill /T on Windows): test runners leave workers behind. */
  killGroup?: boolean;
  /** How long a killed process gets before SIGKILL; a group that still holds its output a moment later is left behind */
  killGraceMs?: number;
  /** Called with each complete output line (stdout and stderr). */
  onLine?: (line: string) => void;
}

export interface RunResult {
  /** Exit code; -1 when the process could not start or was killed. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started (e.g. ENOENT). */
  error?: string;
}

/** Common install locations that a Finder-launched app's PATH lacks. */
const POSIX_EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
  // Docker Desktop installs its CLI (and credential helpers) here without
  // admin rights or the /usr/local/bin symlinks; OrbStack in its own bin.
  join(homedir(), '.docker', 'bin'),
  '/Applications/Docker.app/Contents/Resources/bin',
  join(homedir(), '.orbstack', 'bin'),
  // Node and package managers installed per user
  join(homedir(), '.volta', 'bin'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.cargo', 'bin'),
  '/opt/homebrew/sbin',
  // Always present on macOS, sometimes missing from a GUI app's PATH
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/** bin of the newest Node installed with nvm (nvm only puts it on PATH in shells). */
function nvmNodeBin(): string[] {
  const root = join(homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = readdirSync(root).filter((v) => /^v\d+/.test(v));
    const newest = versions.sort((a, b) => compareVersions(b, a))[0];
    return newest ? [join(root, newest, 'bin')] : [];
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Per-user and Program Files install locations on Windows that the app's Path
 * can lack: Docker Desktop's CLI, npm and pnpm globals, Git's cmd, scoop's
 * shims and nvm-windows' current Node. Only what is set.
 */
function windowsExtraPaths(env: NodeJS.ProcessEnv, exists: Exists): string[] {
  const dirs: string[] = [];
  const at = (name: string, ...rest: string[]) => {
    const base = envValue(env, name);
    if (base) dirs.push(win32.join(base, ...rest));
  };
  at('ProgramFiles', 'Docker', 'Docker', 'resources', 'bin');
  at('APPDATA', 'npm');
  at('LOCALAPPDATA', 'pnpm');
  at('USERPROFILE', '.local', 'bin');
  const bash = findGitBash({ platform: 'win32', env, exists });
  if (bash) dirs.push(win32.join(win32.dirname(win32.dirname(bash)), 'cmd'));
  at('USERPROFILE', 'scoop', 'shims');
  const nvm = envValue(env, 'NVM_SYMLINK');
  if (nvm) dirs.push(nvm);
  return dirs;
}

/** The install locations searchPath adds for a platform. */
export function extraPaths(platform: PlatformKey = getPlatformKey(), env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync): string[] {
  return platform === 'win32' ? windowsExtraPaths(env, exists) : [...POSIX_EXTRA_PATHS, ...nvmNodeBin()];
}

const pathDelimiter = (platform: PlatformKey) => (platform === 'win32' ? ';' : ':');

/** PATH plus the usual Homebrew / user install directories (Docker Desktop, npm, Git on Windows). */
export function searchPath(extra: string[] = [], platform: PlatformKey = getPlatformKey(), env: NodeJS.ProcessEnv = process.env): string {
  const delimiter = pathDelimiter(platform);
  const parts = pathValue(env).split(delimiter).filter(Boolean);
  for (const dir of [...extraPaths(platform, env), ...extra]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Absolute path of an executable on `path`, or undefined. On Windows a bare
 * name is tried with each PATHEXT extension (npm → npm.cmd), never as is: an
 * extension-less file there is a shell script Windows can't run.
 */
export function findOnPath(name: string, path = searchPath(), platform: PlatformKey = getPlatformKey(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  let names = [name];
  if (platform === 'win32') {
    const extensions = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean).map((ext) => ext.toLowerCase());
    if (!extensions.includes(extname(name).toLowerCase())) names = extensions.map((ext) => `${name}${ext}`);
  }
  for (const dir of path.split(pathDelimiter(platform))) {
    if (!dir) continue;
    for (const file of names) {
      const candidate = join(dir, file);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Thrown when a command needs a shell on Windows and Git for Windows is not installed. */
export class GitBashMissingError extends Error {
  constructor() {
    super('Git for Windows is required to run commands on Windows, and its bash.exe was not found. Install it (winget install --id Git.Git -e, or https://git-scm.com/download/win) and restart the app.');
    this.name = 'GitBashMissingError';
  }
}

/**
 * How to run a shell command line: Git Bash on Windows (so project commands
 * have the same syntax everywhere), /bin/sh elsewhere. Throws GitBashMissingError.
 */
export function shellCommand(command: string, platform: PlatformKey = getPlatformKey(), env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] };
  const bash = findGitBash({ platform, env, exists });
  if (!bash) throw new GitBashMissingError();
  return { file: bash, args: ['-c', command] };
}

const bashQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * How to spawn `file`: as is, except a .cmd or .bat shim on Windows (npm, pnpm,
 * yarn, npx), which Node refuses to spawn without a shell (EINVAL) and which
 * runs through shellCommand instead.
 */
export function commandFor(file: string, args: string[], platform: PlatformKey = getPlatformKey(), env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync): { file: string; args: string[] } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  return shellCommand([file.replaceAll('\\', '/'), ...args].map(bashQuote).join(' '), platform, env, exists);
}

interface KillDeps {
  spawn: typeof spawn;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Stop a process and everything it started: `taskkill /T /F` on Windows (there
 * are no process groups; it is always forceful), the process group elsewhere
 * (the process must have been spawned detached). False when nothing was signalled.
 */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM', platform: PlatformKey = getPlatformKey(), deps: KillDeps = { spawn, kill: (p, s) => process.kill(p, s) }): boolean {
  if (platform === 'win32') {
    try {
      const child = deps.spawn(getTaskkillExePath(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => {
        // taskkill missing or the process already gone: nothing left to do
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    deps.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Run a command to completion. Never throws; inspect `code`, `timedOut`, `aborted`, `error`. */
const MAX_PENDING_LINE = 1024 * 1024;
const SETTLE_AFTER_KILL_MS = 1000;

export function runProcess(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 120_000, maxOutput = 16 * 1024 * 1024, signal, onLine, killGraceMs: grace = 5000 } = options;
  const platform = getPlatformKey();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    let command: { file: string; args: string[] };
    try {
      command = commandFor(cmd, args, platform, options.env ?? process.env);
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // A group of its own to kill it as one; Windows has no groups (killTree uses taskkill /T)
    const child = spawn(command.file, command.args, { cwd: options.cwd, env: options.env, detached: options.killGroup === true && platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const lines = (chunk: string) => {
      if (!onLine) return;
      pending += chunk;
      const parts = pending.split('\n');
      // One endless line must not grow without limit
      pending = (parts.pop() ?? '').slice(-MAX_PENDING_LINE);
      for (const line of parts) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdout.length < maxOutput) stdout += text.slice(0, maxOutput - stdout.length);
      lines(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length < maxOutput) stderr += text.slice(0, maxOutput - stderr.length);
      lines(text);
    });

    const send = (signalName: NodeJS.Signals) => {
      // When the group is gone, the process itself
      if (options.killGroup && child.pid && killTree(child.pid, signalName, platform)) return;
      child.kill(signalName);
    };
    const kill = () => {
      send('SIGTERM');
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => send('SIGKILL'), grace).unref();
      // A descendant that left the group can hold the pipes open for ever: the wait ends anyway
      if (options.killGroup) {
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(-1);
        }, grace + SETTLE_AFTER_KILL_MS).unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (pending.trim() && onLine) onLine(pending);
      resolve({ code, stdout, stderr, timedOut, aborted, error });
    };
    child.on('error', (error) => finish(-1, error.message));
    child.on('close', (code) => finish(code ?? -1));
  });
}
