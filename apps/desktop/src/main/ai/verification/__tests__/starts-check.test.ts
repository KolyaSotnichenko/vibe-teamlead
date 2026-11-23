import { describe, expect, it, vi } from 'vitest';

import type { StartServicesDeps } from '../../../preview/start-services';
import { startsCheck, type StartsCheckOptions } from '../starts-check';

const RECIPE = {
  version: 1, kind: 'web',
  services: [
    { name: 'api', dir: 'apps/api', command: 'pnpm run dev', port: 3001, ready: '/health' },
    { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true },
  ],
};

function setup(files: Record<string, string>, over: Partial<StartsCheckOptions> = {}, deps: Partial<StartServicesDeps> = {}) {
  const alive = new Set<number>();
  const started: string[] = [];
  const stopped: string[] = [];
  let picked = 0;
  const serverDeps: StartServicesDeps = {
    startServer: vi.fn(async (o: { name: string; port?: number }) => {
      started.push(o.name);
      const port = o.port ?? 4000 + started.length;
      alive.add(port);
      return { url: `http://localhost:${port}`, port, logPath: `/logs/${o.name}`, reused: false };
    }),
    stopServer: vi.fn(async (name: string) => { stopped.push(name); return true; }),
    pickPort: vi.fn(async () => 4500 + (picked += 1)),
    portFree: vi.fn(async (port: number) => !alive.has(port)),
    probe: vi.fn(async () => ({ status: 200 })),
    readLog: () => 'the log\n',
    readyTimeouts: { timeoutMs: 20, pollMs: 1 },
    ...deps,
  };
  const options: StartsCheckOptions = {
    cwd: '/copy',
    files: Object.keys(files),
    read: (path) => files[path] ?? null,
    saved: [],
    started: [],
    compose: { planned: [], started: [] },
    runCommand: vi.fn(async () => ({ code: 0, output: '' })),
    deps: serverDeps,
    settleMs: 1,
    migratable: true,
    ...over,
  };
  return { options, started, stopped, alive, serverDeps };
}

describe('the start-up check', () => {
  it("fails when a service logs a fatal error as it starts, though its port answers", async () => {
    const { options, stopped } = setup({ 'preview.json': JSON.stringify(RECIPE) }, {}, { readLog: (path: string) => (path.endsWith('starts-api') ? 'error: relation "users" does not exist\nlistening\n' : 'ok\n') });
    const result = await startsCheck(options);
    expect(result?.outcome).toBe('failed');
    expect(result?.tail).toMatch(/^api reported an error as it started: relation "users" does not exist/);
    expect(stopped).toEqual(expect.arrayContaining(['starts-api', 'starts-web']));
  });

  it('passes when every service came up, the page answers, and they are still up a moment later; then stops them', async () => {
    const { options, started, stopped } = setup({ 'preview.json': JSON.stringify(RECIPE) });
    expect(await startsCheck(options)).toEqual({ outcome: 'passed' });
    expect(started).toEqual(['starts-api', 'starts-web']);
    expect(stopped.sort()).toEqual(['starts-api', 'starts-web']);
  });

  it("names its servers after the run, so two runs at once don't stop each other's", async () => {
    const { options, started } = setup({ 'preview.json': JSON.stringify(RECIPE) }, { runId: 'a1b2c3' });
    await startsCheck(options);
    expect(started).toEqual(['starts-a1b2c3-api', 'starts-a1b2c3-web']);
  });

  it("can't say everything when a service the base starts is no longer found, as when its dev script was renamed", async () => {
    // No recipe: what starts is what the files propose, and only the page is proposed now
    const files = { 'apps/web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'apps/api/package.json': JSON.stringify({ scripts: { 'start-dev': 'tsx src/index.ts' } }) };
    const { options } = setup(files, { expectServices: ['api', 'web'] });
    expect(await startsCheck(options)).toEqual({ outcome: 'unavailable', why: { reason: 'missing', names: ['api'] }, tail: 'The project started, but without api, which the commit this task started from starts. Its start may be gone (a renamed dev script?), or it was removed on purpose: look at it.' });
    // Nothing missing: a plain pass
    expect(await startsCheck(setup(files, { expectServices: ['web'] }).options)).toEqual({ outcome: 'passed' });
  });

  it('fails, naming the service, when one does not start', async () => {
    const { options, stopped } = setup({ 'preview.json': JSON.stringify(RECIPE) }, {}, {
      startServer: vi.fn(async (o: { name: string }) => {
        if (o.name === 'starts-web') throw new Error('web exited. Log:\nnpm error Missing script: "dev"');
        return { url: 'http://localhost:3001', port: 3001, logPath: '/l', reused: false };
      }),
    });
    const result = await startsCheck(options);
    expect(result?.outcome).toBe('failed');
    expect(result?.tail).toMatch(/web did not start[\s\S]*Missing script/);
    expect(stopped).toContain('starts-api');
  });

  it('fails when the page answers with a server error', async () => {
    const { options } = setup({ 'preview.json': JSON.stringify(RECIPE) }, {}, { probe: vi.fn(async (url: string) => ({ status: url.endsWith('/health') ? 200 : 500 })) });
    expect(await startsCheck(options)).toMatchObject({ outcome: 'failed', tail: expect.stringMatching(/page.*500/i) });
  });

  it('fails when a service is gone a moment after the page answered', async () => {
    const box = setup({ 'preview.json': JSON.stringify(RECIPE) });
    box.options.settleMs = 5;
    const probe = box.serverDeps.probe;
    box.serverDeps.probe = vi.fn(async (url: string) => {
      const answer = await probe(url);
      // The api dies right after the page's first answer
      if (!url.endsWith('/health')) box.alive.delete(3001);
      return answer;
    });
    expect(await startsCheck(box.options)).toMatchObject({ outcome: 'failed', tail: expect.stringMatching(/api stopped/) });
  });

  it("runs the recipe's build, migrate and seed in their folders first, and fails with the output of the one that failed", async () => {
    const recipe = { ...RECIPE, steps: { build: [{ dir: 'packages/shared', command: 'make lib' }], migrate: [{ dir: 'apps/api', command: 'make migrate' }], seed: [{ dir: 'apps/api', command: 'make seed' }] } };
    const runCommand = vi.fn(async (command: string, _cwd?: string) => ({ code: command === 'make migrate' ? 2 : 0, output: command === 'make migrate' ? 'relation "users" already exists' : '' }));
    const { options, started } = setup({ 'preview.json': JSON.stringify(recipe) }, { runCommand });
    const result = await startsCheck(options);
    expect(runCommand.mock.calls.map(([command, cwd]) => [command, cwd])).toEqual([['make lib', '/copy/packages/shared'], ['make migrate', '/copy/apps/api']]);
    expect(result).toMatchObject({ outcome: 'failed', tail: expect.stringContaining('relation "users" already exists') });
    expect(started).toEqual([]);
  });

  it("never runs the recipe's migrations or seed unless the copy has a throwaway database of its own", async () => {
    const recipe = { ...RECIPE, steps: { install: [], build: [], migrate: [{ dir: 'apps/api', command: 'make migrate' }], seed: [{ dir: 'apps/api', command: 'make seed' }] } };
    const runCommand = vi.fn(async (_command: string, _cwd?: string) => ({ code: 0, output: '' }));
    const { options } = setup({ 'preview.json': JSON.stringify(recipe) }, { runCommand, migratable: false });
    await startsCheck(options);
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([]);
  });

  it("runs the recipe's install first, in its folder", async () => {
    const recipe = { ...RECIPE, steps: { install: [{ dir: 'apps/api', command: 'make deps' }], build: [] } };
    const runCommand = vi.fn(async (_command: string, _cwd?: string) => ({ code: 0, output: '' }));
    const { options } = setup({ 'preview.json': JSON.stringify(recipe) }, { runCommand });
    expect(await startsCheck(options)).toEqual({ outcome: 'passed' });
    expect(runCommand.mock.calls.map(([command, cwd]) => [command, cwd])).toEqual([['make deps', '/copy/apps/api']]);
  });

  it('runs out of time as a whole, and stops what it started', async () => {
    const { options, stopped } = setup({ 'preview.json': JSON.stringify(RECIPE) }, { timeoutMs: 30 }, {
      probe: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return { status: 503 }; }),
      readyTimeouts: { timeoutMs: 10_000, pollMs: 1 },
    });
    expect(await startsCheck(options)).toMatchObject({ outcome: 'timed_out' });
    expect(stopped).toContain('starts-api');
  });

  it("can't say anything when a service could not have the port the project expects: an address it hard-codes reaches something else", async () => {
    const { options } = setup({ 'preview.json': JSON.stringify(RECIPE) }, {}, { portFree: vi.fn(async (port: number) => port !== 3001) });
    const result = await startsCheck(options);
    expect(result).toMatchObject({ outcome: 'unavailable', why: { reason: 'port', names: ['api'], ports: [3001] } });
    expect(result?.tail).toMatch(/api.*3001.*in use/);
  });

  it("names what the base starts when nothing can be started on the task, as when the page's dev script was renamed", async () => {
    const { options } = setup({ 'package.json': JSON.stringify({ scripts: { serve: 'vite' } }) }, { expectServices: ['web'] });
    expect(await startsCheck(options)).toEqual({ outcome: 'unavailable', why: { reason: 'nothing', names: ['web'] }, tail: 'Nothing could be started, while the commit this task started from starts web. Its start may be gone (a renamed dev script?): look at it.' });
  });

  it('cannot say anything when a tool it needs is not installed', async () => {
    const { options } = setup({ 'preview.json': JSON.stringify(RECIPE) }, {}, {
      startServer: vi.fn(async () => { throw new Error('api exited. Log:\nsh: pnpm: command not found'); }),
    });
    expect(await startsCheck(options)).toMatchObject({ outcome: 'unavailable', tail: expect.stringContaining('command not found') });
  });

  it('cannot say anything, and starts nothing, when the run already knows it can\'t', async () => {
    const { options, started } = setup({ 'preview.json': JSON.stringify(RECIPE) }, { cannot: 'Port 10000 is in use on this computer.' });
    expect(await startsCheck(options)).toEqual({ outcome: 'unavailable', tail: 'Port 10000 is in use on this computer.' });
    expect(started).toEqual([]);
  });

  it('has nothing to check for another kind of project, or one with no single page', async () => {
    expect(await startsCheck(setup({ 'preview.json': '{"version":1,"kind":"desktop"}' }).options)).toBeNull();
    expect(await startsCheck(setup({ 'README.md': '' }).options)).toBeNull();
  });

  it('starts what the project proposes when it has no recipe, and the services the owner saved', async () => {
    const proposal = setup({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
    expect(await startsCheck(proposal.options)).toEqual({ outcome: 'passed' });
    expect(proposal.started).toEqual(['starts-web']);
    const saved = setup({ 'README.md': '' }, { saved: [{ name: 'site', dir: '', command: 'make serve', page: true }] });
    expect(await startsCheck(saved.options)).toEqual({ outcome: 'passed' });
    expect(saved.started).toEqual(['starts-site']);
  });

  it("gives the services the copy's database, never a real one", async () => {
    const files = { 'preview.json': JSON.stringify(RECIPE), 'apps/api/.env.example': 'DATABASE_URL=postgresql://u:p@db.example.com:5432/prod\n' };
    const { options, serverDeps } = setup(files, { started: [{ kind: 'postgres', url: 'postgresql://verify:pw@127.0.0.1:55001/verify' }] });
    await startsCheck(options);
    const api = vi.mocked(serverDeps.startServer).mock.calls.find(([o]) => o.name === 'starts-api')?.[0];
    expect(api?.env).toMatchObject({ DATABASE_URL: 'postgresql://verify:pw@127.0.0.1:55001/verify' });
  });

  it('stops everything it started when it is aborted mid-start', async () => {
    const controller = new AbortController();
    const { options, stopped } = setup({ 'preview.json': JSON.stringify(RECIPE) }, { signal: controller.signal }, {
      startServer: vi.fn(async (o: { name: string; port?: number }) => {
        controller.abort();
        return { url: 'http://localhost:1', port: o.port ?? 1, logPath: '/l', reused: false };
      }),
    });
    expect(await startsCheck(options)).toMatchObject({ outcome: 'unavailable' });
    expect(stopped).toContain('starts-api');
  });
});
