/**
 * start_app Tool
 * ==============
 *
 * For QA: the app starts the task's code by the project's recipe, with a fresh database (migrated
 * and seeded) and the compose file's other services, and answers with the page's address. QA used
 * to start databases itself with Docker, and some reviews ended with none (dev-servers/task-app.ts).
 */

import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

export const startAppTool = Tool.define({
  metadata: {
    name: 'mcp__vibe-teamlead__start_app',
    description:
      "Start the whole app of this task as the project's recipe says (preview.json): a fresh database with the migrations and the seed, the compose file's other services, then every server. Answers with the page's address. It keeps running for the next sessions of this task and is stopped with the task; calling it again gives the running one.",
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    if (!context.startApp) return 'Error: this session cannot start the app; start the servers with start_dev_server.';
    try {
      const app = await context.startApp();
      if (!app.ok) return `Error: ${app.reason}`;
      return [
        `${app.reused ? 'Already running' : 'Started'}: the page is at ${app.url}`,
        `Services: ${app.services.join(', ')}`,
        ...(app.notices ?? []),
        app.database ? `With a fresh ${app.database} database, migrated and seeded: sign in with the project's test sign-in and its seeded users.` : 'No database was started (the compose file names none).',
        "Don't stop it: the next session uses it, and the app stops it with the task.",
      ].join('\n');
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
