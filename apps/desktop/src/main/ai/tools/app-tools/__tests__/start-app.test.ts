import { describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../../types';
import { startAppTool } from '../start-app';

const run = (context: Partial<ToolContext>) => startAppTool.config.execute({} as never, context as ToolContext);

describe('start_app', () => {
  it("answers with the running app's address and what runs with it", async () => {
    const startApp = vi.fn(async () => ({ ok: true as const, url: 'http://localhost:5173', reused: false, services: ['api at http://localhost:3000', 'web at http://localhost:5173'], database: 'postgres' }));
    const output = String(await run({ startApp }));
    expect(output).toContain('http://localhost:5173');
    expect(output).toContain('api at http://localhost:3000');
    expect(output).toMatch(/fresh postgres database, migrated and seeded/);
  });

  it("says why it couldn't, and that the session has no such app when the app gave none", async () => {
    expect(String(await run({ startApp: async () => ({ ok: false as const, reason: 'The database could not start' }) }))).toMatch(/^Error: The database could not start/);
    expect(String(await run({}))).toMatch(/^Error:/);
  });
});
