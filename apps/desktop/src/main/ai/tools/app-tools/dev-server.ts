/**
 * start_dev_server / stop_dev_server Tools
 * ========================================
 *
 * Agents ask for a dev server; the app gives it a free port, waits until it
 * answers and keeps it for the task. See ai/dev-servers/dev-servers.ts.
 */

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod/v3';

import { startDevServer, stopAllDevServers, stopDevServer } from '../../dev-servers/dev-servers';
import { validateCommand } from '../../security/bash-validator';
import { isPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

/** These change what the command runs or loads, which the command check could not see. */
const FORBIDDEN_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELL|HOME)$/;

export const startDevServerTool = Tool.define({
  metadata: {
    name: 'mcp__vibe-teamlead__start_dev_server',
    description:
      'Start a dev server, or get the one already running. The app picks a free port, passes it in PORT, waits until the server answers and returns its URL. It keeps running for the next sessions of this task and is stopped with the task.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema: z.object({
    name: z.string().regex(/^[\w-]{1,40}$/).describe('Short name, e.g. "api" or "web"'),
    command: z.string().min(1).describe('Command to run, e.g. "pnpm --filter @x/web dev". {port} in it becomes the port.'),
    cwd: z.string().optional().describe('Folder inside the worktree to run it in (default: the worktree root)'),
    port: z.number().int().min(1).max(65535).optional().describe('Port you would like; another is used if it is taken'),
    port_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional().describe('Variable the server reads its port from (default: PORT)'),
    env: z.record(z.string()).optional().describe('More environment variables, e.g. the URL of another server'),
  }),
  execute: async (input, context) => {
    const [allowed, reason] = validateCommand(input.command);
    if (!allowed) return `Error: command not allowed: ${reason}`;
    const cwd = input.cwd ? (isAbsolute(input.cwd) ? resolve(input.cwd) : resolve(context.cwd, input.cwd)) : context.cwd;
    if (!isPathContained(cwd, context.cwd).contained) return `Error: ${input.cwd} is outside the worktree`;
    const forbidden = Object.keys(input.env ?? {}).find((key) => FORBIDDEN_ENV.test(key));
    if (forbidden) return `Error: ${forbidden} can't be set for a dev server`;
    try {
      const server = await startDevServer({
        name: input.name,
        command: input.command,
        cwd,
        specDir: context.specDir,
        port: input.port,
        portEnv: input.port_env,
        env: input.env,
      });
      return `${server.reused ? 'Already running' : 'Started'}: ${server.url} (log: ${server.logPath}). Don't stop it when you finish: the next session can use it, and the app stops it with the task.`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const stopDevServerTool = Tool.define({
  metadata: {
    name: 'mcp__vibe-teamlead__stop_dev_server',
    description: 'Stop a dev server started with start_dev_server, with everything it started. Without a name, stops all of them. You only need this to restart one.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema: z.object({
    name: z.string().optional().describe('Name given to start_dev_server'),
  }),
  execute: async (input) => {
    if (!input.name) {
      await stopAllDevServers();
      return 'Stopped all dev servers.';
    }
    return (await stopDevServer(input.name)) ? `Stopped ${input.name}.` : `No dev server named ${input.name} is running.`;
  },
});
