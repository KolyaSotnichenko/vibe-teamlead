import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanUpLeftovers,
  containersOfWorktree,
  isDevServerCommand,
  startDevServer,
  stopAllDevServers,
  stopDevServer,
} from '../dev-servers';

const SERVER = `require('http').createServer((q, s) => s.end('hi ' + (process.env.GREETING || ''))).listen(+process.env.PORT)`;

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vtl-dev-'));
  writeFileSync(path.join(dir, 'server.js'), SERVER);
  return { cwd: dir, specDir: dir };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  await stopAllDevServers();
});

describe('dev servers', () => {
  it('starts on a free port, waits until it answers and passes the env', async () => {
    const p = project();
    const started = await startDevServer({ ...p, name: 'web', command: 'node server.js', env: { GREETING: 'there' } });
    expect(started.reused).toBe(false);
    await expect((await fetch(started.url)).text()).resolves.toBe('hi there');
  });

  it("keeps the session's credentials out of the server's environment", async () => {
    const p = project();
    writeFileSync(path.join(p.cwd, 'server.js'), `require('http').createServer((q, s) => s.end(String(process.env.ANTHROPIC_API_KEY))).listen(+process.env.PORT)`);
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    try {
      const started = await startDevServer({ ...p, name: 'web', command: 'node server.js' });
      await expect((await fetch(started.url)).text()).resolves.toBe('undefined');
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it('uses another port when the asked one is taken', async () => {
    const p = project();
    const taken: Server = createServer();
    await new Promise<void>((r) => taken.listen(0, () => r()));
    const port = (taken.address() as { port: number }).port;
    const started = await startDevServer({ ...p, name: 'web', command: 'node server.js', port });
    expect(started.port).not.toBe(port);
    taken.close();
  });

  it('puts the port in the command when asked to', async () => {
    const p = project();
    const started = await startDevServer({ ...p, name: 'web', command: 'PORT={port} node server.js', portEnv: 'UNUSED' });
    await expect((await fetch(started.url)).text()).resolves.toContain('hi');
  });

  it('reuses a running server, and restarts it when the command changes', async () => {
    const p = project();
    const first = await startDevServer({ ...p, name: 'web', command: 'node server.js' });
    const again = await startDevServer({ ...p, name: 'web', command: 'node server.js' });
    expect(again).toMatchObject({ reused: true, port: first.port });
    const changed = await startDevServer({ ...p, name: 'web', command: 'node server.js', env: { GREETING: 'x' } });
    expect(changed.reused).toBe(false);
    await expect((await fetch(changed.url)).text()).resolves.toBe('hi x');
  });

  it('stopping kills the whole process group, not just the wrapper', async () => {
    const p = project();
    // The shell stays as the wrapper; node is its child, which `kill <wrapper>` would leave behind
    await startDevServer({ ...p, name: 'web', command: 'node server.js & echo $! > child.pid; wait' });
    const child = Number(readFileSync(path.join(p.cwd, 'child.pid'), 'utf-8'));
    expect(alive(child)).toBe(true);
    expect(await stopDevServer('web')).toBe(true);
    // An orphan is reaped a moment after it dies. Not checked by port: another test may get it next.
    await expect.poll(() => alive(child), { timeout: 2000 }).toBe(false);
  });

  it('reports the log when a server never listens, and leaves nothing running', async () => {
    const p = project();
    await expect(
      startDevServer({ ...p, name: 'web', command: 'echo missing config; sleep 30', timeoutMs: 400 }),
    ).rejects.toThrow(/missing config/);
    expect(await stopDevServer('web')).toBe(false);
  });

  it('reports the log when a server exits at once', async () => {
    const p = project();
    await expect(startDevServer({ ...p, name: 'web', command: 'echo boom; exit 3' })).rejects.toThrow(/boom/);
  });

  it('cleans up what a killed run left behind, checking it is the same process', async () => {
    const p = project();
    const started = await startDevServer({ ...p, name: 'web', command: 'node server.js' });
    const file = path.join(p.specDir, 'dev-servers', 'servers.json');
    expect(existsSync(file)).toBe(true);
    const [entry] = JSON.parse(readFileSync(file, 'utf-8'));
    // An unrelated process that happens to have a listed pid, with another start time
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    writeFileSync(file, JSON.stringify([{ ...entry, pid: other.pid, startedAt: 'long ago' }, entry]));
    cleanUpLeftovers(p.specDir);
    expect(alive(other.pid as number)).toBe(true);
    expect(execFileSync('ps', ['-o', 'pid=', '-p', String(other.pid)]).toString().trim()).toBe(String(other.pid));
    process.kill(-(other.pid as number), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(started.url)).rejects.toThrow();
  });
});

describe('cleanUpLeftovers with a list an agent could have written', () => {
  const list = (specDir: string, content: string) => {
    mkdirSync(path.join(specDir, 'dev-servers'), { recursive: true });
    writeFileSync(path.join(specDir, 'dev-servers', 'servers.json'), content);
  };

  it.each(['{}', 'null', '"x"', '[1, null, {"pid": "7"}]', 'not json'])('survives %s', (content) => {
    const { specDir } = project();
    list(specDir, content);
    expect(() => cleanUpLeftovers(specDir)).not.toThrow();
  });

  it("leaves alone a process that isn't running in this task's folder", async () => {
    const { specDir } = project();
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'vtl-other-')));
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', cwd: elsewhere });
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(other.pid)]).toString().trim();
    list(specDir, JSON.stringify([{ pid: other.pid, startedAt }]));
    cleanUpLeftovers(specDir);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(other.pid as number)).toBe(true);
    process.kill(-(other.pid as number), 'SIGKILL');
  });

  it("never reaches the user's own processes when the spec sits in the main project", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vtl-main-')));
    const specDir = path.join(root, '.vibe-teamlead', 'specs', '001-x');
    mkdirSync(specDir, { recursive: true });
    const mine = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', cwd: root });
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(mine.pid)]).toString().trim();
    list(specDir, JSON.stringify([{ pid: mine.pid, startedAt }]));
    cleanUpLeftovers(specDir);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(mine.pid as number)).toBe(true);
    process.kill(-(mine.pid as number), 'SIGKILL');
  });

  it('stops a leftover that does run in this folder', async () => {
    const { specDir } = project();
    const left = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', cwd: specDir });
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(left.pid)]).toString().trim();
    list(specDir, JSON.stringify([{ pid: left.pid, startedAt }]));
    cleanUpLeftovers(specDir);
    await expect.poll(() => alive(left.pid as number), { timeout: 2000 }).toBe(false);
  });
});

describe('isDevServerCommand', () => {
  it.each([
    'pnpm run dev',
    'pnpm --filter @x/web dev',
    'npm run dev -- -p 3000',
    '(cd apps/api && pnpm run start:dev) > /tmp/api.log &',
    'cd apps/web && nohup next dev -p 3010 &',
    'pnpm exec next dev -p 3010 & sleep 8 && curl -s localhost:3010',
    'nest start --watch',
    'yarn dev',
  ])('catches %s', (command) => {
    expect(isDevServerCommand(command)).toBe(true);
  });

  it.each([
    'pnpm test',
    'pnpm build',
    'pnpm add -D vite',
    'pnpm --filter @x/web build-storybook',
    'npm run dev:debug',
    'pnpm --filter @x/api db:migrate',
    'grep -rn "next dev" package.json',
    'docker compose up -d postgres',
    'ls /dev/null',
  ])('leaves %s alone', (command) => {
    expect(isDevServerCommand(command)).toBe(false);
  });
});

describe('containersOfWorktree', () => {
  it('finds the containers a task worktree started, and only those', () => {
    const worktree = '/p/.vibe-teamlead/worktrees/tasks/003-x';
    const ps = [`aaa ${worktree}`, `bbb ${worktree}/apps/api`, 'ccc /p', 'ddd /p/.vibe-teamlead/worktrees/tasks/003-x2', 'eee'].join('\n');
    expect(containersOfWorktree(ps, worktree)).toEqual(['aaa', 'bbb']);
  });

  it('never touches containers of a folder that is not a task worktree', () => {
    expect(containersOfWorktree('aaa /p\nbbb /p/apps', '/p')).toEqual([]);
  });
});
