/**
 * Runs a project's Storybook dev server for the in-app component view.
 * One server per project, on a free local port; stopped on request and on quit.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { getAugmentedEnv } from '../env-utils';

interface Running {
  child?: ChildProcess;
  url?: string;
  ready: Promise<string>;
}

const servers = new Map<string, Running>();
const START_TIMEOUT_MS = 180_000;

function freePort(preferred = 6006): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(port)));
    });
  return tryPort(preferred).catch(() => tryPort(0).then((p) => p));
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
    // npm run <script> -- -p PORT --ci (no browser); without a script, the CLI directly
    const args = script
      ? ['run', script, '--', '-p', String(port), '--ci']
      : ['exec', '--', 'storybook', 'dev', '-p', String(port), '--ci'];
    const child = spawn('npm', args, {
      cwd: key,
      env: { ...getAugmentedEnv(), BROWSER: 'none', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry.child = child;
    entry.url = url;

    return new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
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
    running.child?.kill('SIGTERM');
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
  for (const running of servers.values()) running.child?.kill('SIGTERM');
  servers.clear();
}

/** Stop every server running from a folder inside `root` (a worktree being removed). */
export function stopStorybooksUnder(root: string): void {
  const base = path.resolve(root);
  for (const [key, running] of servers) {
    if (key === base || key.startsWith(`${base}${path.sep}`)) {
      running.child?.kill('SIGTERM');
      servers.delete(key);
    }
  }
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

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
    const child = spawn(pm, ['install'], { cwd: key, env: { ...getAugmentedEnv(), CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
