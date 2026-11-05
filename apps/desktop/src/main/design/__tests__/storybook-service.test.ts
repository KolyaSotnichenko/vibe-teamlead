import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

const fakePm = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('../../platform/exec', async (importActual) => {
  const actual = await importActual<typeof import('../../platform/exec')>();
  return { ...actual, findOnPath: (name: string, searched?: string) => fakePm.path ?? actual.findOnPath(name, searched) };
});

import { freePort, installDependencies, needsInstall, packageManagerOf, startStorybook, stopAllStorybooks, stopStorybook, stopStorybooksUnder, storybookArgs, storybookUrlFromOutput, touchesStorybook } from '../storybook-service';

const dir = () => mkdtempSync(path.join(tmpdir(), 'vtl-sb-'));

describe('storybook service', () => {
  it('picks the package manager from the lockfile', () => {
    const d = dir();
    expect(packageManagerOf(d)).toBe('npm');
    writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
    expect(packageManagerOf(d)).toBe('pnpm');
  });

  it('needs an install when neither the Storybook folder nor the root has node_modules', () => {
    const d = dir();
    mkdirSync(path.join(d, 'apps', 'web'), { recursive: true });
    expect(needsInstall(d, 'apps/web')).toBe(true);
    mkdirSync(path.join(d, 'node_modules'));
    expect(needsInstall(d, 'apps/web')).toBe(false);
  });

  it('reads the local URL Storybook prints', () => {
    expect(storybookUrlFromOutput('│   Local:            http://localhost:6007/   │')).toBe('http://localhost:6007');
    expect(storybookUrlFromOutput('starting…')).toBeNull();
  });

  it('runs one install per folder and reports a failure with its output', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'definitely-not-a-real-package-vtl-xyz': '0.0.0' } }));
    const lines: string[] = [];
    const first = installDependencies(d, (l) => lines.push(l));
    expect(installDependencies(d)).toBe(first);
    await expect(first).rejects.toThrow(/npm install failed/);
    expect(lines[0]).toBe('npm install');
  }, 120_000);
});

describe('stopping a Storybook', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  afterEach(() => {
    fakePm.path = undefined;
    stopAllStorybooks();
  });

  /** As pnpm does it: the package manager is a wrapper, and the server is a process below it */
  const started = async () => {
    const project = dir();
    const pidFile = path.join(project, 'server.pid');
    fakePm.path = path.join(project, 'fake-pm');
    writeFileSync(fakePm.path, `#!/bin/sh\nsh -c 'echo $$ > "${pidFile}"; echo "Local: http://localhost:6006/"; exec sleep 60' &\nwait\n`);
    chmodSync(fakePm.path, 0o755);
    await startStorybook(project, '.', undefined);
    return { project, pid: Number(readFileSync(pidFile, 'utf-8')) };
  };

  it.each([
    ['the Stop button', (project: string) => stopStorybook(project, '.')],
    ['quitting the app', () => stopAllStorybooks()],
    ['removing the worktree', (project: string) => stopStorybooksUnder(project)],
  ])('%s ends the server, not only the package manager in front of it', async (_name, stop) => {
    const { project, pid } = await started();
    expect(alive(pid)).toBe(true);
    stop(project);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });
});

describe('task Storybook relevance', () => {
  it('shows only for tasks that change UI files the Storybook shows', () => {
    expect(touchesStorybook(['apps/api/src/users.controller.ts', 'apps/api/prisma/schema.prisma'], 'apps/web')).toBe(false);
    expect(touchesStorybook(['apps/web/src/Button.tsx'], 'apps/web')).toBe(true);
    expect(touchesStorybook(['apps/web/src/Button.stories.tsx'], 'apps/web')).toBe(true);
    // a .tsx outside the Storybook folder doesn't count
    expect(touchesStorybook(['apps/mobile/App.tsx'], 'apps/web')).toBe(false);
    expect(touchesStorybook(['apps/webhooks/x.tsx'], 'apps/web')).toBe(false);
    // tests and non-UI files inside the folder don't count
    expect(touchesStorybook(['apps/web/src/Button.test.tsx', 'apps/web/src/api.ts'], 'apps/web')).toBe(false);
    // Storybook at the root: any UI file
    expect(touchesStorybook(['src/Card.tsx'], '.')).toBe(true);
    expect(touchesStorybook(['src/server.ts'], '.')).toBe(false);
  });
});

describe('storybook command', () => {
  it('uses the project package manager; only npm needs -- before the flags', () => {
    expect(storybookArgs('npm', 'storybook', 6006)).toEqual(['run', 'storybook', '--', '-p', '6006', '--ci']);
    expect(storybookArgs('pnpm', 'storybook', 6006)).toEqual(['run', 'storybook', '-p', '6006', '--ci']);
    expect(storybookArgs('pnpm', undefined, 6006)).toEqual(['exec', 'storybook', 'dev', '-p', '6006', '--ci']);
    expect(storybookArgs('npm', undefined, 6006)).toEqual(['exec', '--', 'storybook', 'dev', '-p', '6006', '--ci']);
  });
});

describe('free port', () => {
  it('falls back to a real port the OS picked when the preferred one is taken (never 0)', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const taken = (busy.address() as { port: number }).port;
    try {
      const port = await freePort(taken);
      expect(port).not.toBe(taken);
      expect(port).toBeGreaterThan(0);
    } finally {
      busy.close();
    }
  });
});

