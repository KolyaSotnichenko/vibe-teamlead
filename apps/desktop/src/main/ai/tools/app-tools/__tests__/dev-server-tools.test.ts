import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { stopAllDevServers } from '../../../dev-servers/dev-servers';
import type { ToolContext } from '../../types';
import { startDevServerTool, stopDevServerTool } from '../dev-server';

function context() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'vtl-devtool-')));
  writeFileSync(path.join(cwd, 'server.js'), `require('http').createServer((q, s) => s.end('ok')).listen(+process.env.PORT)`);
  return { cwd, specDir: cwd, projectDir: cwd } as unknown as ToolContext;
}

const start = (input: Record<string, unknown>, ctx: ToolContext) => startDevServerTool.config.execute({ name: 'web', ...input } as never, ctx) as Promise<string>;

afterEach(async () => {
  await stopAllDevServers();
});

describe('dev server tools', () => {
  it('returns the URL, and stop stops it', async () => {
    const ctx = context();
    const text = await start({ command: 'node server.js' }, ctx);
    const url = /http:\/\/localhost:\d+/.exec(text)?.[0] as string;
    await expect((await fetch(url)).text()).resolves.toBe('ok');
    await expect(stopDevServerTool.config.execute({ name: 'web' } as never, ctx)).resolves.toContain('Stopped');
    await expect(fetch(url)).rejects.toThrow();
  });

  it('applies the same command rules as Bash', async () => {
    await expect(start({ command: 'shutdown -h now' }, context())).resolves.toMatch(/^Error:/);
  });

  it('stays inside the worktree', async () => {
    await expect(start({ command: 'node server.js', cwd: '../..' }, context())).resolves.toMatch(/^Error:.*outside/);
  });

  it('does not let the env change how commands are found or loaded', async () => {
    await expect(start({ command: 'node server.js', env: { NODE_OPTIONS: '--require x' } }, context())).resolves.toMatch(/^Error:.*NODE_OPTIONS/);
    await expect(start({ command: 'node server.js', env: { PATH: '/tmp' } }, context())).resolves.toMatch(/^Error:.*PATH/);
  });

  it('turns a failed start into an answer the agent can read', async () => {
    await expect(start({ command: 'echo nope; exit 1' }, context())).resolves.toMatch(/^Error:.*nope/s);
  });
});
