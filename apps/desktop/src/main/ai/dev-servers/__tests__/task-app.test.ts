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

  // As the app's checks: an address from the owner's settings may be any database, so nothing is migrated or seeded there
  it("runs no migration or seed when the project's settings or a committed .env name a database", async () => {
    const { deps, commands } = setup();
    const owned = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa', projectEnv: { DATABASE_URL: 'postgres://me:pw@db.example.com/prod' } }, deps).start();
    expect(commands).toEqual([]);
    expect(owned).toMatchObject({ ok: true, notices: [expect.stringMatching(/DATABASE_URL/)] });
    expect(owned).not.toHaveProperty('database');
    // The owner's value reaches the servers, not the throwaway one
    const committed = setup({ 'package.json': '{}', 'preview.json': JSON.stringify(RECIPE), 'docker-compose.yml': COMPOSE, '.env': 'DATABASE_URL=postgres://u:p@prod.example.com/app\n' });
    await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, committed.deps).start();
    expect(committed.commands).toEqual([]);
  });

  it("runs no migration when a setting points at a database under any name", async () => {
    const { deps, commands } = setup();
    await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa', projectEnv: { PROD_CONN: 'postgres://me:pw@prod.example.com/app' } }, deps).start();
    expect(commands).toEqual([]);
  });

  it('a secret cut through by the end of the output still never shows', async () => {
    const { deps } = setup();
    const secret = 'S3CRET-VALUE-0123456789';
    // The kept tail starts inside the secret
    deps.runCommand = vi.fn(async () => ({ code: 1, output: `${secret}${'x'.repeat(1990)}` }));
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa', projectEnv: { API_TOKEN: secret } }, deps).start();
    const reason = result.ok ? '' : result.reason;
    expect(reason).not.toMatch(/0123456789/);
  });

  it('a stop sweeps every container with its label, also one whose start was cut short', async () => {
    const { deps, docker } = setup();
    const app = createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa-7' }, deps);
    await app.start();
    docker.mockClear();
    await app.stop();
    expect(docker.mock.calls.some(([args]) => args[0] === 'ps' && args.join(' ').includes('label=vibe-teamlead-verify=qa-7'))).toBe(true);
  });

  it("gives the migrations and seed no database address from the recipe, and says so", async () => {
    const recipe = { ...RECIPE, env: { PROD_CONN: 'postgres://me:pw@prod.example.com/app' } };
    const { deps, commands } = setup({ 'package.json': '{}', 'preview.json': JSON.stringify(recipe), 'docker-compose.yml': COMPOSE });
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    expect(commands.map((c) => c.command)).toEqual(['pnpm migrate:up', 'pnpm db:seed']);
    expect(commands.every((c) => !JSON.stringify(c.env).includes('prod.example.com'))).toBe(true);
    expect(result).toMatchObject({ ok: true, notices: [expect.stringMatching(/PROD_CONN/)] });
  });

  it("runs the recipe's own install step", async () => {
    const recipe = { ...RECIPE, steps: { ...RECIPE.steps, install: [{ dir: 'apps/api', command: 'make deps' }] } };
    const { deps, commands } = setup({ 'package.json': '{}', 'preview.json': JSON.stringify(recipe), 'docker-compose.yml': COMPOSE });
    await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps).start();
    expect(commands[0].command).toBe('make deps');
  });

  it("a secret cut through by a server's log tail never shows", async () => {
    const { deps } = setup();
    const secret = 'S3CRET-VALUE-0123456789';
    deps.servers.startServer = vi.fn(async () => {
      // A log tail cut through the value, as dev-servers gives it
      throw new Error(`app-api did not listen. Log:\n${secret.slice(5)} rest of the line\nnext line`);
    });
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa', projectEnv: { API_TOKEN: secret } }, deps).start();
    const reason = result.ok ? '' : result.reason;
    expect(reason).not.toMatch(/0123456789/);
    expect(reason).toContain('next line');
  });

  it('starts once when asked twice at the same time', async () => {
    const { deps, started } = setup();
    const app = createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps);
    const [a, b] = await Promise.all([app.start(), app.start()]);
    expect(started).toEqual(['app-api', 'app-web']);
    expect([a, b].every((r) => r.ok)).toBe(true);
  });

  it('a stop during the start ends it there and leaves nothing running', async () => {
    const { deps, docker, started } = setup();
    let release = () => {};
    deps.runCommand = vi.fn(() => new Promise<{ code: number; output: string }>((resolve) => { release = () => resolve({ code: 0, output: '' }); }));
    const app = createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa' }, deps);
    const starting = app.start();
    await vi.waitFor(() => expect(deps.runCommand).toHaveBeenCalled());
    const stopping = app.stop();
    release();
    await stopping;
    expect(await starting).toMatchObject({ ok: false });
    expect(started).toEqual([]);
    expect(docker.mock.calls.some(([args]) => args[0] === 'rm' && args.includes('c1'))).toBe(true);
  });

  it("hides the owner's values and the database's password from what it answers", async () => {
    const { deps, docker } = setup();
    deps.runCommand = vi.fn(async (_c, _cwd, env) => ({ code: 1, output: `connect ${env.DATABASE_URL} with ${env.API_TOKEN}` }));
    const result = await createTaskApp({ worktree: '/wt', specDir: '/s', label: 'qa', projectEnv: { API_TOKEN: 'tok-secret-123' } }, deps).start();
    const reason = result.ok ? '' : result.reason;
    const run = docker.mock.calls.map(([args]) => args).find((args) => args[0] === 'run') ?? [];
    const password = run.find((arg) => arg.startsWith('POSTGRES_PASSWORD='))?.split('=')[1] ?? '';
    expect(password.length).toBeGreaterThan(8);
    expect(reason).not.toContain(password);
    expect(reason).not.toContain('tok-secret-123');
    expect(reason).toContain('***');
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
