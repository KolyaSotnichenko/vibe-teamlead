/**
 * Runs a project's Storybook dev server for the in-app component view.
 * One server per project, on a free local port; stopped on request and on quit.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { getAugmentedEnv } from '../env-utils';
import { isWindows } from '../platform';
import { findOnPath, searchPath } from '../platform/exec';
import { isUiFile } from '../ai/design/design-lint';

interface Running {
  child?: ChildProcess;
  url?: string;
  ready: Promise<string>;
}

const servers = new Map<string, Running>();
const START_TIMEOUT_MS = 180_000;

/**
 * The server is several processes below the package manager, and a signal to the
 * package manager alone leaves it running. It starts as a group, and stops as one.
 */
function stopTree(child: ChildProcess | undefined): void {
  if (!child) return;
  try {
    if (child.pid && !isWindows()) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    // Already gone
  }
}

/**
 * A free port: the preferred one, or one the OS picks. Port 0 asks the OS, so
 * the answer is the port it actually bound, never 0 (Storybook refuses 0).
 */
export function freePort(preferred = 6006): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        server.close(() => resolve(bound));
      });
    });
  return tryPort(preferred).catch(() => tryPort(0));
}

/** The URL once Storybook prints it (or answers on the port). Pure parser — tested directly. */
export function storybookUrlFromOutput(text: string): string | null {
  const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/);
  return m ? m[0].replace(/\/$/, '') : null;
}

/** Start (or reuse) the Storybook of `dir` inside `projectPath`. */
export function startStorybook(projectPath: string, dir: string, script: string | undefined): Promise<string> {
  const key = path.resolve(projectPath, dir);
  const existing = servers.get(key);
  if (existing && (existing.child?.exitCode ?? null) === null) return existing.ready;

  const entry: Running = { ready: Promise.resolve('') };
  entry.ready = (async () => {
    const port = await freePort();
    const url = `http://localhost:${port}`;
    // The project's own package manager, found where a Finder-launched app can't
    // see it (nvm, Homebrew, pnpm's home): a bare PATH gave "spawn npm ENOENT"
    const pm = packageManagerOf(projectPath);
    const env = toolEnv();
    const child = spawn(findOnPath(pm, env.PATH) ?? pm, storybookArgs(pm, script, port), {
      cwd: key,
      env: { ...env, BROWSER: 'none', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows(),
    });
    entry.child = child;
    entry.url = url;

    return new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        stopTree(child);
        reject(new Error(`Storybook did not start within ${START_TIMEOUT_MS / 1000}s.${output ? `\n${output.slice(-800)}` : ''}`));
      }, START_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 20_000) output = output.slice(-20_000);
        if (/Local:|Storybook .* started|storybook started/i.test(output) && storybookUrlFromOutput(output)) {
          clearTimeout(timer);
          resolve(url);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (servers.get(key) === entry) servers.delete(key);
        reject(new Error(`Storybook exited (${code ?? 'signal'}).${output ? `\n${output.slice(-800)}` : ''}`));
      });
    });
  })();

  servers.set(key, entry);
  entry.ready.catch(() => {
    if (servers.get(key) === entry) servers.delete(key);
  });
  return entry.ready;
}

export function stopStorybook(projectPath: string, dir: string): void {
  const key = path.resolve(projectPath, dir);
  const running = servers.get(key);
  if (running) {
    stopTree(running.child);
    servers.delete(key);
  }
}

/** The running server's URL, if any. */
export function runningStorybook(projectPath: string, dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const running = servers.get(path.resolve(projectPath, dir));
  return running?.child && running.child.exitCode === null ? running.url : undefined;
}

export function stopAllStorybooks(): void {
  for (const running of servers.values()) stopTree(running.child);
  servers.clear();
}

/** Stop every server running from a folder inside `root` (a worktree being removed). */
export function stopStorybooksUnder(root: string): void {
  const base = path.resolve(root);
  for (const [key, running] of servers) {
    if (key === base || key.startsWith(`${base}${path.sep}`)) {
      stopTree(running.child);
      servers.delete(key);
    }
  }
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Environment for package-manager processes: the app's env with the full tool PATH. */
function toolEnv(): Record<string, string> {
  const env = getAugmentedEnv();
  return { ...env, PATH: searchPath(env.PATH ? env.PATH.split(path.delimiter) : []) };
}

/**
 * Arguments that start Storybook on `port` without opening a browser. npm needs
 * `--` before the script's own flags; pnpm, yarn and bun pass them through.
 * Without a script, the storybook CLI runs directly. Pure — tested directly.
 */
export function storybookArgs(pm: PackageManager, script: string | undefined, port: number): string[] {
  const flags = ['-p', String(port), '--ci'];
  if (script) return pm === 'npm' ? ['run', script, '--', ...flags] : ['run', script, ...flags];
  if (pm === 'npm') return ['exec', '--', 'storybook', 'dev', ...flags];
  if (pm === 'bun') return ['x', 'storybook', 'dev', ...flags];
  if (pm === 'yarn') return ['storybook', 'dev', ...flags];
  return ['exec', 'storybook', 'dev', ...flags];
}

/**
 * Whether a task's changes reach the UI that Storybook shows: a UI file
 * (components, styles, stories) inside the Storybook's folder, or anywhere when
 * Storybook is at the root. An API-only task has none. Pure — tested directly.
 */
export function touchesStorybook(changed: string[], dir: string): boolean {
  const base = dir.replace(/^\.(\/|$)/, '').replace(/\/+$/, '');
  return changed.some((file) => isUiFile(file) && (!base || file === base || file.startsWith(`${base}/`)));
}

/** The package manager a folder uses, from its lockfile (npm when none). */
export function packageManagerOf(root: string): PackageManager {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Dependencies are missing when neither the Storybook folder nor the root has node_modules. */
export function needsInstall(root: string, dir: string): boolean {
  return !existsSync(path.join(root, dir, 'node_modules')) && !existsSync(path.join(root, 'node_modules'));
}

const installs = new Map<string, Promise<void>>();
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Install the dependencies of `root` (once at a time per folder); `onLine` gets the latest output line. */
export function installDependencies(root: string, onLine?: (line: string) => void): Promise<void> {
  const key = path.resolve(root);
  const existing = installs.get(key);
  if (existing) return existing;
  const pm = packageManagerOf(key);
  const job = new Promise<void>((resolve, reject) => {
    onLine?.(`${pm} install`);
    const env = toolEnv();
    const child = spawn(findOnPath(pm, env.PATH) ?? pm, ['install'], { cwd: key, env: { ...env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${pm} install did not finish within ${INSTALL_TIMEOUT_MS / 60000} minutes.`));
    }, INSTALL_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000);
      const last = tail.trim().split('\n').pop()?.trim();
      if (last) onLine?.(last.slice(0, 200));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${pm} install failed (${code ?? 'signal'}).\n${tail.slice(-800)}`));
    });
  }).finally(() => installs.delete(key));
  installs.set(key, job);
  return job;
}

export function isInstalling(root: string): boolean {
  return installs.has(path.resolve(root));
}
