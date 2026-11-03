/**
 * Running external tools (scanners, Docker, Strix, CodeGraph) from the main
 * process or a worker: one place for timeouts, abort, output limits and
 * finding executables when the app was started from Finder (minimal PATH).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this long (default 2 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Keep at most this many characters of stdout / stderr (default 16 MB). */
  maxOutput?: number;
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
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];

/** PATH plus the usual Homebrew / user install directories. */
export function searchPath(extra: string[] = []): string {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...EXTRA_PATHS, ...extra]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

/** Absolute path of an executable on `path`, or undefined. */
export function findOnPath(name: string, path = searchPath()): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Run a command to completion. Never throws; inspect `code`, `timedOut`, `aborted`, `error`. */
export function runProcess(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 120_000, maxOutput = 16 * 1024 * 1024, signal, onLine } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      pending = parts.pop() ?? '';
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

    const kill = () => {
      child.kill('SIGTERM');
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
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
