import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project, PreviewService } from '../../../shared/types/project';
import { inMergeQueue } from '../../ai/merge/merge-queue';
import type { PreviewDatabase } from '../preview-database';
import { type PreviewDeps, type PreviewStatus, currentPreview, startPreview, stopPreview } from '../preview-session';

const SERVICES: PreviewService[] = [
  { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true, urlEnv: { NEXT_PUBLIC_API_URL: 'api' } },
  { name: 'api', dir: 'apps/api', command: 'pnpm run start:dev' },
];

function project(id = 'p1', services = SERVICES): Project {
  return {
    id, name: id, path: `/projects/${id}`, autoBuildPath: '', createdAt: new Date(), updatedAt: new Date(),
    settings: { model: 'm', memoryBackend: 'file', linearSync: false, notifications: { onTaskComplete: false, onTaskFailed: false, onReviewNeeded: false, sound: false }, previewServices: services, previewEnv: { FEATURE_X: 'on' } },
  } as Project;
}

const FILES: Record<string, string> = {
  'pnpm-lock.yaml': '',
  'docker-compose.yml': 'services:\n  db:\n    image: postgres:18-alpine\n',
  'apps/api/package.json': JSON.stringify({ scripts: { seed: 'node scripts/seed.mjs' }, dependencies: { '@acme/shared': 'workspace:*' } }),
  'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', main: './dist/index.js', scripts: { build: 'tsc' } }),
  'apps/api/prisma/schema.prisma': '',
  'apps/api/.env.example': 'DATABASE_URL=postgresql://u:p@localhost:5432/x\nJWT_SECRET=dev-secret\n',
  'apps/web/.env.example': 'NEXT_PUBLIC_SITE=preview\n',
  'apps/web/.env': 'SECRET_FROM_REAL_ENV=leak\n',
};

function database(overrides: Partial<PreviewDatabase> = {}): PreviewDatabase {
  return { status: 'started', started: [{ kind: 'postgres', url: 'postgresql://verify:pw@127.0.0.1:55001/verify' }], fresh: true, stop: vi.fn(async () => {}), ...overrides };
}

function deps(overrides: Partial<PreviewDeps> = {}) {
  const order: string[] = [];
  let port = 4100;
  const d: PreviewDeps = {
    git: 'git',
    docker: async () => ({ ok: true, stdout: '' }),
    secretsDir: '/tmp/secrets',
    sync: vi.fn(async (projectPath: string) => { order.push('worktree'); return { path: `${projectPath}/.vibe-teamlead/worktrees/preview`, lockfileChanged: false }; }),
    listFiles: () => Object.keys(FILES),
    read: (_root: string, path: string) => FILES[path] ?? null,
    needsInstall: () => false,
    install: vi.fn(async () => { order.push('install'); }),
    startDatabase: vi.fn(async () => { order.push('database'); return database(); }),
    runCommand: vi.fn(async (command: string, cwd: string) => { order.push(command.includes('seed') ? 'seed' : command.endsWith('run build') ? `build:${cwd.split('/').pop()}` : 'migrations'); return { code: 0, output: '' }; }),
    startServer: vi.fn(async (o: { name: string }) => { order.push(`server:${o.name}`); port += 1; return { url: `http://localhost:${port}`, port, logPath: '/log', reused: false }; }),
    stopServer: vi.fn(async () => true),
    cleanUpLeftovers: vi.fn(),
    pickPort: vi.fn(async () => 6000 + Math.floor(Math.random() * 1000)),
    ...overrides,
  };
  return { d, order };
}

afterEach(async () => {
  await stopPreview();
});

describe('a preview session', () => {
  it('runs the stages in order and returns the page URL', async () => {
    const { d, order } = deps();
    const stages: string[] = [];
    const status = await startPreview(project(), (s) => stages.push(s.stage), d);
    expect(order).toEqual(['worktree', 'build:shared', 'database', 'migrations', 'seed', 'server:preview-api', 'server:preview-web']);
    expect(status.stage).toBe('ready');
    expect(status.url).toBe('http://localhost:4102');
    expect(status.origins).toEqual(['http://localhost:4102']);
    expect(stages.at(-1)).toBe('ready');
    expect(currentPreview()?.stage).toBe('ready');
  });

  it("passes the env: example values, the database URL, previewEnv, and other services' URLs", async () => {
    const { d } = deps();
    await startPreview(project(), () => {}, d);
    const calls = vi.mocked(d.startServer).mock.calls.map(([o]) => o as { name: string; env: Record<string, string>; cwd: string });
    const api = calls.find((c) => c.name === 'preview-api')!;
    const web = calls.find((c) => c.name === 'preview-web')!;
    expect(api.cwd).toBe('/projects/p1/.vibe-teamlead/worktrees/preview/apps/api');
    expect(api.env).toMatchObject({ DATABASE_URL: 'postgresql://verify:pw@127.0.0.1:55001/verify', JWT_SECRET: 'dev-secret', FEATURE_X: 'on' });
    expect(web.env).toMatchObject({ NEXT_PUBLIC_SITE: 'preview', NEXT_PUBLIC_API_URL: 'http://localhost:4101', FEATURE_X: 'on' });
    expect(JSON.stringify(calls)).not.toContain('leak');
  });

  it("lets a backend name the page's URL, which starts after it", async () => {
    const services: PreviewService[] = [
      { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true, urlEnv: { NEXT_PUBLIC_API_BASE_URL: 'api' } },
      { name: 'api', dir: 'apps/api', command: 'pnpm run start:dev', urlEnv: { WEB_ORIGIN: 'web' } },
    ];
    const ports = [5001, 5002];
    const { d } = deps({
      pickPort: vi.fn(async () => ports.shift() ?? 0),
      startServer: vi.fn(async (o: { port?: number }) => ({ url: `http://localhost:${o.port}`, port: o.port ?? 0, logPath: '/log', reused: false })),
    });
    const status = await startPreview(project('p1', services), () => {}, d);
    const calls = vi.mocked(d.startServer).mock.calls.map(([o]) => o as { name: string; env: Record<string, string>; port?: number });
    const web = calls.find((c) => c.name === 'preview-web')!;
    const api = calls.find((c) => c.name === 'preview-api')!;
    expect(api.env.WEB_ORIGIN).toBe(`http://localhost:${web.port}`);
    expect(web.env.NEXT_PUBLIC_API_BASE_URL).toBe(`http://localhost:${api.port}`);
    expect(status.url).toBe(`http://localhost:${web.port}`);
  });

  it('installs when the lockfile changed or node_modules is missing, and not otherwise', async () => {
    const first = deps();
    await startPreview(project(), () => {}, first.d);
    expect(first.d.install).not.toHaveBeenCalled();
    await stopPreview();
    const second = deps({ needsInstall: () => true });
    await startPreview(project(), () => {}, second.d);
    expect(second.d.install).toHaveBeenCalledTimes(1);
  });

  it('runs the seed only on a fresh database, and migrations only when a database started', async () => {
    const kept = deps({ startDatabase: vi.fn(async () => database({ fresh: false })) });
    await startPreview(project(), () => {}, kept.d);
    expect(kept.order).toContain('migrations');
    expect(kept.order).not.toContain('seed');
    await stopPreview();
    const none = deps({ startDatabase: vi.fn(async () => database({ status: 'none', started: [], fresh: false })) });
    await startPreview(project(), () => {}, none.d);
    expect(none.order).not.toContain('migrations');
    expect(none.order).not.toContain('seed');
  });

  it('a library that fails to build fails the preview with its output', async () => {
    const { d } = deps({ runCommand: vi.fn(async (command: string) => (command.endsWith('run build') ? { code: 2, output: 'src/index.ts(1,1): error TS1005' } : { code: 0, output: '' })) });
    const status = await startPreview(project(), () => {}, d);
    expect(status.stage).toBe('failed');
    expect(status.message).toContain('@acme/shared');
    expect(status.logTail).toContain('TS1005');
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("a second start stops the first project's preview first", async () => {
    const first = deps();
    await startPreview(project('p1'), () => {}, first.d);
    const second = deps();
    await startPreview(project('p2'), () => {}, second.d);
    expect(first.d.stopServer).toHaveBeenCalledWith('preview-api');
    expect(first.d.stopServer).toHaveBeenCalledWith('preview-web');
    expect(currentPreview()?.projectId).toBe('p2');
  });

  it('stop during start stops what started and the rest never start', async () => {
    let release!: () => void;
    const db = database();
    const { d } = deps({ startDatabase: vi.fn(() => new Promise<PreviewDatabase>((resolve) => { release = () => resolve(db); })) });
    const statuses: PreviewStatus[] = [];
    const starting = startPreview(project(), (s) => statuses.push(s), d);
    await vi.waitFor(() => expect(d.startDatabase).toHaveBeenCalled());
    const stopping = stopPreview();
    release();
    const result = await starting;
    await stopping;
    expect(d.startServer).not.toHaveBeenCalled();
    expect(db.stop).toHaveBeenCalled();
    expect(result.stage).toBe('stopped');
    expect(statuses.some((s) => s.stage === 'ready')).toBe(false);
    expect(currentPreview()).toBeNull();
  });

  it('a failing service reports its name and log tail and stops the others', async () => {
    const db = database();
    const { d } = deps({
      startDatabase: vi.fn(async () => db),
      startServer: vi.fn(async (o: { name: string }) => {
        if (o.name === 'preview-web') throw new Error('web exited before listening on port 4102. Log:\nError: Cannot find module next');
        return { url: 'http://localhost:4101', port: 4101, logPath: '/log', reused: false };
      }),
    });
    const status = await startPreview(project(), () => {}, d);
    expect(status.stage).toBe('failed');
    expect(status.message).toContain('web');
    expect(status.logTail).toContain('Cannot find module next');
    expect(d.stopServer).toHaveBeenCalledWith('preview-api');
    expect(db.stop).toHaveBeenCalled();
  });

  it('without Docker the services still start', async () => {
    const { d } = deps({ startDatabase: vi.fn(async () => database({ status: 'unavailable', started: [], fresh: false, reason: "Docker isn't running." })) });
    const status = await startPreview(project(), () => {}, d);
    expect(status.stage).toBe('ready');
    expect(status.database).toBe('unavailable');
    expect(status.databaseReason).toBe("Docker isn't running.");
  });

  it('refuses to start without a page service', async () => {
    const { d } = deps();
    const status = await startPreview(project('p1', [{ name: 'api', dir: 'apps/api', command: 'x' }]), () => {}, d);
    expect(status.stage).toBe('failed');
    expect(d.sync).not.toHaveBeenCalled();
  });

  it('a settled merge of the previewed project re-syncs the worktree', async () => {
    const { d } = deps();
    await startPreview(project(), () => {}, d);
    vi.mocked(d.sync).mockClear();
    vi.mocked(d.startServer).mockClear();

    await inMergeQueue('/projects/p1', 't1', async () => {});
    await vi.waitFor(() => expect(d.sync).toHaveBeenCalledTimes(1));
    expect(d.startServer).not.toHaveBeenCalled();

    vi.mocked(d.sync).mockResolvedValueOnce({ path: '/projects/p1/.vibe-teamlead/worktrees/preview', lockfileChanged: true });
    await inMergeQueue('/projects/p1', 't2', async () => {});
    await vi.waitFor(() => expect(d.startServer).toHaveBeenCalledTimes(2));
    expect(d.install).toHaveBeenCalledTimes(1);
    expect(d.stopServer).toHaveBeenCalledWith('preview-web');
  });

  it("ignores merges of other projects", async () => {
    const { d } = deps();
    await startPreview(project(), () => {}, d);
    vi.mocked(d.sync).mockClear();
    await inMergeQueue('/projects/other', 't1', async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.sync).not.toHaveBeenCalled();
  });
});
