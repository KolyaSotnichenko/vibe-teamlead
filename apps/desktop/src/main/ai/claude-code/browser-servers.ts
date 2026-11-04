/**
 * A browser server that can't start must not reach the session: its instructions
 * would promise tools that aren't there, and the agent would spend turns calling
 * them and guessing other names. Checked up front, because the session's own
 * report of a failed server comes after its instructions are fixed. No Electron imports.
 */

import { spawnSync } from 'node:child_process';

const BROWSER_SERVERS = new Set(['playwright', 'chrome-devtools']);
const CHECK_TIMEOUT_MS = 15_000;

/** Can this CLI load at all? A check that only ran out of time isn't a verdict. */
export function cliStarts(command: string, cli: string, env: Record<string, string | undefined>): boolean {
  const result = spawnSync(command, [cli, '--help'], {
    env: { ...process.env, ...env },
    timeout: CHECK_TIMEOUT_MS,
    stdio: 'ignore',
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return true;
  return result.status === 0;
}

/** A session starts many times with the same servers; the answer doesn't change while it runs */
const checked = new Map<string, boolean>();

function cachedCliStarts(command: string, cli: string, env: Record<string, string | undefined>): boolean {
  const key = `${command}\0${cli}`;
  const known = checked.get(key);
  if (known !== undefined) return known;
  const works = cliStarts(command, cli, env);
  checked.set(key, works);
  return works;
}

interface MaybeStdio {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

export function removeBrokenBrowserServers<T>(
  servers: Record<string, T>,
  onProblem?: (message: string) => void,
  canStart: (command: string, cli: string, env: Record<string, string | undefined>) => boolean = cachedCliStarts,
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [name, server] of Object.entries(servers)) {
    const { type, command, args, env } = server as MaybeStdio;
    if (BROWSER_SERVERS.has(name) && type === 'stdio' && command && args?.[0] && !canStart(command, args[0], env ?? {})) {
      onProblem?.(`Browser server "${name}" could not start, so this session goes without it.`);
      continue;
    }
    kept[name] = server;
  }
  return kept;
}
