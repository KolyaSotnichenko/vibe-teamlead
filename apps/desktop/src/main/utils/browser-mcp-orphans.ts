/**
 * Orphaned browser servers of the app. QA and the UX review drive a browser through the bundled
 * Playwright MCP (and the QA fixer through chrome-devtools-mcp), started by the agent's Claude
 * Code session; when that session is cut short (a stopped task, a worker that had to be killed,
 * the app quit mid-QA) the server and the Chrome it started can be left running with no parent.
 *
 * Only the app's own servers (by the exact bundled path in their command line) whose parent is
 * gone (re-parented to launchd, ppid 1) are stopped, with every process under them. Someone
 * else's Playwright or the user's Chrome are never touched.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isWindows } from '../platform';

export interface PsEntry {
  pid: number;
  ppid: number;
  command: string;
}

const KILL_GRACE_MS = 1500;

/** `ps -axo pid=,ppid=,command=` output. Pure. */
export function parsePs(output: string): PsEntry[] {
  const entries: PsEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return entries;
}

/** The app's orphaned browser servers and every process under them, roots first. Pure. */
export function orphanedBrowserTrees(processes: PsEntry[], bundledPaths: string[]): number[] {
  const paths = bundledPaths.filter(Boolean);
  if (!paths.length) return [];
  const roots = processes.filter((p) => p.ppid === 1 && paths.some((path) => p.command.includes(path)));
  const children = new Map<number, number[]>();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const out: number[] = [];
  const walk = (pid: number) => {
    if (out.includes(pid)) return;
    out.push(pid);
    for (const child of children.get(pid) ?? []) walk(child);
  };
  for (const root of roots) walk(root.pid);
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Find and stop them: SIGTERM, then SIGKILL what is left. Returns how many were found. Never throws. */
export async function stopOrphanedBrowserServers(bundledPaths: Array<string | undefined>): Promise<number> {
  if (isWindows()) return 0;
  try {
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 });
    const pids = orphanedBrowserTrees(parsePs(stdout), bundledPaths.filter((p): p is string => !!p));
    if (!pids.length) return 0;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    for (const pid of pids.filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    return pids.length;
  } catch {
    return 0;
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Look for orphans a little after a session ended (a normal end closes its servers first), at most
 * once per few seconds however many sessions end together. Main process.
 */
export function cleanUpBrowserOrphansSoon(bundledPaths: () => Array<string | undefined>, delayMs = 3000): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    void stopOrphanedBrowserServers(bundledPaths());
  }, delayMs);
}
