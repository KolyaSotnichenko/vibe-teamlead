import { describe, expect, it, vi } from 'vitest';

import { createTaskApp, type TaskAppDeps } from '../task-app';

const RECIPE = {
  version: 1,
  kind: 'web',
  services: [
    { name: 'api', dir: 'apps/api', command: 'pnpm run dev', port: 3000, ready: '/health' },
    { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true },
  ],
  steps: { migrate: [{ dir: '', command: 'pnpm migrate:up' }], seed: [{ dir: 'apps/api', command: 'pnpm db:seed' }] },
};
const COMPOSE = 'services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: x\n';

function setup(files: Record<string, string> = { 'package.json': '{"name":"x"}', 'preview.json': JSON.stringify(RECIPE), 'docker-compose.yml': COMPOSE, '.env.example': 'DATABASE_URL=postgres://u:p@localhost:5432/app\nVITE_AUTH_MODE=test\n' }) {
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'info') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'run') return { ok: true, stdout: 'c1\n', stderr: '' };
    if (args[0] === 'port') return { ok: true, stdout: '127.0.0.1:55432\n', stderr: '' };
    if (args[0] === 'exec') return { ok: true, stdout: '', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  });
  const commands: Array<{ command: string; cwd: string; env: Record<string, string> }> = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const deps: TaskAppDeps = {
    docker: docker as never,
    listFiles: async () => Object.keys(files),
    installCommand: () => null,
    portOpen: async () => true,
    read: (path) => files[path] ?? null,
    runCommand: vi.fn(async (command, cwd, env) => {
      commands.push({ command, cwd, env });
      return { code: 0, output: '' };
    }),
    servers: {
      startServer: vi.fn(async (o: { name: string; port?: number }) => {
        started.push(o.name);
        const port = o.port ?? 5173;
        return { url: `http://localhost:${port}`, port, logPath: `/logs/${o.name}`, reused: false };
      }),
      stopServer: vi.fn(async (name: string) => {
        stopped.push(name);
        return true;
      }),
      pickPort: vi.fn(async () => 4501),
      portFree: vi.fn(async () => true),
      probe: vi.fn(async () => ({ status: 200 })),
      readLog: () => '',
      readyTimeouts: { timeoutMs: 20, pollMs: 1 },
    },
  };
  return { deps, docker, commands, started, stopped };
}

describe('the app QA works against', () => {
  it('starts the project by its recipe with a fresh database, migrated and seeded, and says where', async () => {
    const { deps, docker, commands, started } = setup();
    const app = createTaskApp({ worktree: '/wt', specDir: '/wt/.vibe-teamlead/specs/042', label: 'qa-042' }, deps);

    const result = await app.start();

    expect(result).toMatchObject({ ok: true, url: expect.stringMatching(/^http:\/\/localhost:\d+$/), reused: false });
    expect(docker.mock.calls.some(([args]) => args[0] === 'run' && args.includes('postgres:16-alpine'))).toBe(true);
    expect(commands.map((c) => c.command)).toEqual(['pnpm migrate:up', 'pnpm db:seed']);
    // Migrations and seed reach the fresh database, never the example's
    expect(commands[0].env.DATABASE_URL).toMatch(/55432/);
    expect(started).toEqual(['app-api', 'app-web']);
  });

  it('gives the running app again, and stops it all (servers and containers) when the task lets go', async () => {
    const { deps, docker, started, stopped } = setup();
    const app = createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa-042' }, deps);
    await app.start();
    expect(await app.start()).toMatchObject({ ok: true, reused: true });
    expect(started).toHaveLength(2);

    await app.stop();
    expect(stopped.sort()).toEqual(['app-api', 'app-web']);
    expect(docker.mock.calls.some(([args]) => args[0] === 'rm' && args.includes('c1'))).toBe(true);
  });

  it("installs the dependencies first when the worktree has none", async () => {
    const { deps, commands } = setup();
    deps.installCommand = () => 'pnpm install';
    await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    expect(commands.map((c) => c.command)).toEqual(['pnpm install', 'pnpm migrate:up', 'pnpm db:seed']);
  });

  // planner-mhp: the API reaches Azurite at 127.0.0.1:10000, written in its code
  it("publishes a compose service on the compose file's own port when it is free, so hard-coded addresses reach it", async () => {
    const azurite = `${COMPOSE}  azurite:\n    image: mcr.microsoft.com/azure-storage/azurite\n    ports:\n      - "10000:10000"\n`;
    const { deps, docker } = setup({ 'package.json': '{}', 'preview.json': JSON.stringify(RECIPE), 'docker-compose.yml': azurite });
    await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    const run = docker.mock.calls.map(([args]) => args).find((args) => args[0] === 'run' && args.some((a) => a.includes('azurite')));
    expect(run?.join(' ')).toContain('127.0.0.1:10000:10000');
  });

  it("says when a compose service had to take another port: addresses the project hard-codes miss it", async () => {
    const azurite = `${COMPOSE}  azurite:\n    image: mcr.microsoft.com/azure-storage/azurite\n    ports:\n      - "10000:10000"\n`;
    const { deps } = setup({ 'package.json': '{}', 'preview.json': JSON.stringify(RECIPE), 'docker-compose.yml': azurite });
    deps.servers.portFree = vi.fn(async (port: number) => port !== 10000);
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    expect(result).toMatchObject({ ok: true, notices: [expect.stringMatching(/azurite[\s\S]*10000/)] });
  });

  it('says why when the project has no recipe with a single page', async () => {
    const { deps } = setup({ 'README.md': '# x' });
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/preview\.json/) });
  });

  it('stops what it started when a step fails, and says which and why', async () => {
    const { deps, docker, stopped } = setup();
    deps.runCommand = vi.fn(async () => ({ code: 1, output: 'relation "users" does not exist' }));
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/pnpm migrate:up[\s\S]*users/) });
    expect(stopped).toEqual([]);
    expect(docker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(true);
  });
});
