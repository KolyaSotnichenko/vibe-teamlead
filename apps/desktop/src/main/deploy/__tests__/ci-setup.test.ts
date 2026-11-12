import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { cleanupVercelLeftovers, isCiSetUp, VERCEL_LEFTOVERS } from '../ci-setup';

const repo = { owner: 'me', repo: 'app', createdByApp: true, public: false };
const project = (deploy: unknown) => ({ settings: { deploy } }) as never;

describe('isCiSetUp', () => {
  it('a project set up under the old Deploy (enabled, repo and a Vercel project) is set up', () => {
    expect(isCiSetUp(project({ enabled: true, repo, vercel: { projectId: 'prj', projectName: 'app' } }))).toBe(true);
  });
  it('a recorded repository is enough', () => {
    expect(isCiSetUp(project({ repo }))).toBe(true);
    expect(isCiSetUp(project({ enabled: false, repo }))).toBe(true);
  });
  it('no repository: not set up', () => {
    expect(isCiSetUp(project({ enabled: true }))).toBe(false);
    expect(isCiSetUp(project({ enabled: false }))).toBe(false);
    expect(isCiSetUp(project(undefined))).toBe(false);
    expect(isCiSetUp({ settings: undefined } as never)).toBe(false);
    expect(isCiSetUp(undefined)).toBe(false);
  });
});

describe('cleanupVercelLeftovers', () => {
  it('removes exactly the credential file, the CLI folder and the link folder', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'vt-userdata-'));
    writeFileSync(path.join(userData, 'vercel-credential.json'), '{}');
    mkdirSync(path.join(userData, 'vercel-cli', 'bin'), { recursive: true });
    writeFileSync(path.join(userData, 'vercel-cli', 'bin', 'vercel'), 'x');
    mkdirSync(path.join(userData, 'vercel-link', 'tmp-1'), { recursive: true });
    // kept
    mkdirSync(path.join(userData, 'deploy'), { recursive: true });
    writeFileSync(path.join(userData, 'deploy', 'branch-pushes.json'), '{}');
    writeFileSync(path.join(userData, 'settings.json'), '{}');
    writeFileSync(path.join(userData, 'vercel-other.json'), '{}');

    await cleanupVercelLeftovers(userData);

    expect(readdirSync(userData).sort()).toEqual(['deploy', 'settings.json', 'vercel-other.json']);
    expect(readdirSync(path.join(userData, 'deploy'))).toEqual(['branch-pushes.json']);
  });

  it('missing paths are fine', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'vt-userdata-'));
    await expect(cleanupVercelLeftovers(userData)).resolves.toBeUndefined();
    await expect(cleanupVercelLeftovers(path.join(userData, 'nope'))).resolves.toBeUndefined();
  });

  it('asks to remove only those three paths, and a failure (permission error) neither throws nor stops the others', async () => {
    const rm = vi.fn(async (p: string, _options: { recursive?: boolean; force?: boolean }) => {
      if (p.endsWith('vercel-credential.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    await expect(cleanupVercelLeftovers('/u', { rm })).resolves.toBeUndefined();
    expect(rm.mock.calls.map((c) => c[0])).toEqual([
      path.join('/u', 'vercel-credential.json'),
      path.join('/u', 'vercel-cli'),
      path.join('/u', 'vercel-link'),
    ]);
    expect(rm.mock.calls.every((c) => c[1].recursive === true && c[1].force === true)).toBe(true);
    expect(VERCEL_LEFTOVERS).toEqual(['vercel-credential.json', 'vercel-cli', 'vercel-link']);
  });

  it('a synchronous throw is swallowed too', async () => {
    const rm = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(cleanupVercelLeftovers('/u', { rm: rm as never })).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(3);
  });

  it('no user data path: nothing happens', async () => {
    const rm = vi.fn(async () => undefined);
    await expect(cleanupVercelLeftovers('', { rm })).resolves.toBeUndefined();
    expect(rm).not.toHaveBeenCalled();
  });
});
