import { describe, expect, it, vi } from 'vitest';

import type { PreviewService } from '../../../shared/types/project';
import { saidFor } from '../../say';
import { baseEnvVars } from '../preview-env';
import { startRecipeServices, type StartServicesDeps, type StartServicesInput } from '../start-services';

const SERVICES: PreviewService[] = [
  { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true, urlEnv: { VITE_API_URL: 'api' } },
  { name: 'api', dir: 'apps/api', command: 'pnpm run dev', env: { AUTH_MODE: 'dev' } },
];
const FILES: Record<string, string> = {
  'apps/api/.env.example': 'PORT=3001\n',
  'apps/web/.env.example': 'VITE_OTHER=http://localhost:3001/v1\n',
};

function setup(over: Partial<StartServicesDeps> = {}, input: Partial<StartServicesInput> = {}) {
  let next = 4100;
  const servers: string[] = [];
  const deps: StartServicesDeps = {
    startServer: vi.fn(async (o: { name: string; port?: number }) => {
      const port = o.port ?? (next += 1);
      return { url: `http://localhost:${port}`, port, logPath: `/logs/${o.name}`, reused: false };
    }),
    stopServer: vi.fn(async () => true),
    pickPort: vi.fn(async () => (next += 1)),
    portFree: vi.fn(async () => true),
    probe: vi.fn(async () => ({ status: 200 })),
    readLog: () => 'the end of the log\n',
    readyTimeouts: { timeoutMs: 30, pollMs: 1 },
    ...over,
  };
  const read = (path: string) => FILES[path] ?? null;
  const options: StartServicesInput = {
    services: SERVICES,
    root: '/wt',
    specDir: '/wt/.spec',
    serverName: (service) => `check-${service.name}`,
    read,
    baseVars: (dir) => baseEnvVars({ dir, rootExample: null, dirExample: read(`${dir}/.env.example`), started: [] }),
    timeoutMs: 1000,
    check: () => {},
    onServer: (name) => servers.push(name),
    ...input,
  };
  return { deps, options, servers };
}

describe('startRecipeServices', () => {
  it('starts the backends first and the page last, each on the port the project expects when it is free', async () => {
    const { deps, options, servers } = setup();
    const started = await startRecipeServices(options, deps);
    const calls = vi.mocked(deps.startServer).mock.calls.map(([o]) => o);
    expect(calls.map((o) => [o.name, o.port, o.cwd])).toEqual([['check-api', 3001, '/wt/apps/api'], ['check-web', expect.any(Number), '/wt/apps/web']]);
    expect(servers).toEqual(['check-api', 'check-web']);
    expect(started.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(started.logs).toEqual({ api: '/logs/check-api', web: '/logs/check-web' });
  });

  it('picks another port when the expected one is taken, and says which moved', async () => {
    const { deps, options } = setup({ portFree: vi.fn(async (port: number) => port !== 3001) });
    const started = await startRecipeServices(options, deps);
    expect(started.ports.api).not.toBe(3001);
    expect(started.displaced).toEqual({ api: { ownPort: 3001, previewPort: started.ports.api } });
  });

  it("gives each service the others' addresses, its own recipe values, and the port", async () => {
    const { deps, options } = setup({ portFree: vi.fn(async (port: number) => port !== 3001) });
    const started = await startRecipeServices(options, deps);
    const [api, web] = vi.mocked(deps.startServer).mock.calls.map(([o]) => o);
    expect(api.env).toMatchObject({ AUTH_MODE: 'dev' });
    expect(web.env).toMatchObject({ VITE_API_URL: `http://localhost:${started.ports.api}`, VITE_OTHER: `http://localhost:${started.ports.api}/v1` });
    expect(web.env).not.toHaveProperty('AUTH_MODE');
    expect(started.vars.api.find((v) => v.name === 'PORT')?.value).toBe(String(started.ports.api));
  });

  it('waits for a ready path, and names the service when it never gets ready or is gone', async () => {
    const services = [{ ...SERVICES[0] }, { ...SERVICES[1], ready: '/health' }];
    const slow = setup({ probe: vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValue({ status: 200 }) }, { services });
    await expect(startRecipeServices(slow.options, slow.deps)).resolves.toBeDefined();

    const never = setup({ probe: vi.fn(async () => ({ status: 503 })) }, { services });
    const error = (await startRecipeServices(never.options, never.deps).catch((e: unknown) => e)) as Error & { service?: string; logTail?: string };
    expect(error.message).toBe('api did not get ready: /health answered 503');
    expect(error).toMatchObject({ service: 'api', logTail: 'the end of the log' });
    expect(saidFor([error.message])).toMatchObject([{ key: 'notReady' }]);

    const gone = setup({ probe: vi.fn(async () => ({ error: 'ECONNREFUSED' })), portFree: vi.fn(async () => true) }, { services });
    await expect(startRecipeServices(gone.options, gone.deps)).rejects.toMatchObject({ message: 'api stopped before it was ready', service: 'api' });
  });

  it('names a service that did not start, with what it printed', async () => {
    const { deps, options } = setup({ startServer: vi.fn(async () => { throw new Error('api exited before listening. Log:\nMissing script: dev'); }) });
    await expect(startRecipeServices(options, deps)).rejects.toMatchObject({ message: 'api did not start', service: 'api', logTail: expect.stringContaining('Missing script') });
  });

  it('stops between services when asked to, and stops one that finished starting meanwhile', async () => {
    let stop = false;
    const stopped = new Error('stopped');
    const { deps, options } = setup(
      { startServer: vi.fn(async (o: { name: string; port?: number }) => { stop = true; return { url: 'http://localhost:1', port: o.port ?? 1, logPath: '/l', reused: false }; }) },
      { check: () => { if (stop) throw stopped; } },
    );
    await expect(startRecipeServices(options, deps)).rejects.toBe(stopped);
    expect(deps.stopServer).toHaveBeenCalledWith('check-api');
    expect(deps.startServer).toHaveBeenCalledTimes(1);
  });
});
