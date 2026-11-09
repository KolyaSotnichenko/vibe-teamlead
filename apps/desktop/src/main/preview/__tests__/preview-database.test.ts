import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DockerRun } from '../../ai/verification/test-services';
import { previewTaskKey, removePreviewLeftovers, removeTaskPreviewVolumes, startPreviewDatabase } from '../preview-database';
import { writeFileSync } from 'node:fs';

const POSTGRES = [{ kind: 'postgres' as const, image: 'postgres:18-alpine' }];

function fakeDocker(options: { info?: boolean; volumeExists?: boolean; leftovers?: string[] } = {}) {
  const calls: string[][] = [];
  let volumeExists = options.volumeExists ?? false;
  const docker: DockerRun = async (args) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === 'info') return { ok: options.info ?? true, stdout: '' };
    if (cmd === 'volume' && sub === 'inspect') return { ok: volumeExists, stdout: '' };
    if (cmd === 'volume' && sub === 'rm') { volumeExists = false; return { ok: true, stdout: '' }; }
    if (cmd === 'ps') return { ok: true, stdout: (options.leftovers ?? []).join('\n') };
    if (cmd === 'run') { volumeExists = true; return { ok: true, stdout: 'abc123\n' }; }
    if (cmd === 'port') return { ok: true, stdout: '127.0.0.1:55001\n' };
    return { ok: true, stdout: '' };
  };
  return { docker, calls };
}

const secretsDir = () => mkdtempSync(join(tmpdir(), 'preview-secrets-'));
const runArgs = (calls: string[][]) => calls.find((c) => c[0] === 'run') ?? [];
const passwordOf = (calls: string[][]) => runArgs(calls).find((a) => a.startsWith('POSTGRES_PASSWORD='));

describe('the preview database', () => {
  it('mounts a named volume per project and kind', async () => {
    const { docker, calls } = fakeDocker();
    const db = await startPreviewDatabase(POSTGRES, { docker, projectId: 'p1', secretsDir: secretsDir() });
    const args = runArgs(calls);
    expect(args).toEqual(expect.arrayContaining(['-v', 'vibe-teamlead-preview-p1-postgres:/var/lib/postgresql', '--label', 'vibe-teamlead-preview=p1', '-p', '127.0.0.1::5432']));
    expect(args).toContain('--rm');
    expect(db.status).toBe('started');
    expect(db.started[0]?.url).toMatch(/^postgresql:\/\/verify:[0-9a-f]+@127\.0\.0\.1:55001\/verify$/);
  });

  it('reuses the stored password', async () => {
    const dir = secretsDir();
    const first = fakeDocker();
    await startPreviewDatabase(POSTGRES, { docker: first.docker, projectId: 'p1', secretsDir: dir });
    const second = fakeDocker({ volumeExists: true });
    await startPreviewDatabase(POSTGRES, { docker: second.docker, projectId: 'p1', secretsDir: dir });
    expect(passwordOf(second.calls)).toBe(passwordOf(first.calls));
  });

  it('reports fresh only when the volume did not exist', async () => {
    expect((await startPreviewDatabase(POSTGRES, { docker: fakeDocker().docker, projectId: 'p1', secretsDir: secretsDir() })).fresh).toBe(true);
    expect((await startPreviewDatabase(POSTGRES, { docker: fakeDocker({ volumeExists: true }).docker, projectId: 'p1', secretsDir: secretsDir() })).fresh).toBe(false);
  });

  it('reset removes the volume and its password first', async () => {
    const dir = secretsDir();
    const first = fakeDocker();
    await startPreviewDatabase(POSTGRES, { docker: first.docker, projectId: 'p1', secretsDir: dir });
    const again = fakeDocker({ volumeExists: true });
    const db = await startPreviewDatabase(POSTGRES, { docker: again.docker, projectId: 'p1', secretsDir: dir, reset: true });
    const rm = again.calls.findIndex((c) => c[0] === 'volume' && c[1] === 'rm' && c.includes('vibe-teamlead-preview-p1-postgres'));
    expect(rm).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(again.calls.findIndex((c) => c[0] === 'run'));
    expect(passwordOf(again.calls)).not.toBe(passwordOf(first.calls));
    expect(db.fresh).toBe(true);
  });

  it('is unavailable with the Docker reason when docker info fails', async () => {
    const db = await startPreviewDatabase(POSTGRES, { docker: fakeDocker({ info: false }).docker, projectId: 'p1', secretsDir: secretsDir() });
    expect(db.status).toBe('unavailable');
    expect(db.reason).toMatch(/Docker isn't running/);
  });

  it('is none when the compose file names no database', async () => {
    const { docker, calls } = fakeDocker();
    expect((await startPreviewDatabase([], { docker, projectId: 'p1', secretsDir: secretsDir() })).status).toBe('none');
    expect(calls).toEqual([]);
  });

  it('stop removes the container and keeps the volume', async () => {
    const { docker, calls } = fakeDocker();
    const db = await startPreviewDatabase(POSTGRES, { docker, projectId: 'p1', secretsDir: secretsDir() });
    await db.stop();
    const rm = calls.filter((c) => c[0] === 'rm');
    expect(rm).toEqual([['rm', '-f', 'abc123']]);
    expect(calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false);
  });

  it('removePreviewLeftovers removes containers with the preview label and keeps volumes', async () => {
    const { docker, calls } = fakeDocker({ leftovers: ['old1', 'old2'] });
    await removePreviewLeftovers(docker);
    expect(calls[0]).toEqual(['ps', '-aq', '--filter', 'label=vibe-teamlead-preview']);
    expect(calls.slice(1)).toEqual([['rm', '-f', 'old1'], ['rm', '-f', 'old2']]);
  });

  it('a reset that cannot remove the volume gives up and keeps the stored password', async () => {
    const dir = secretsDir();
    const first = fakeDocker();
    await startPreviewDatabase(POSTGRES, { docker: first.docker, projectId: 'p1', secretsDir: dir });
    const busy = fakeDocker({ volumeExists: true });
    const docker: DockerRun = async (args) => (args[0] === 'volume' && args[1] === 'rm' ? { ok: false, stdout: 'volume is in use' } : busy.docker(args));
    const db = await startPreviewDatabase(POSTGRES, { docker, projectId: 'p1', secretsDir: dir, reset: true });
    expect(db.status).toBe('unavailable');
    expect(db.reason).toContain('volume is in use');
    const again = fakeDocker({ volumeExists: true });
    await startPreviewDatabase(POSTGRES, { docker: again.docker, projectId: 'p1', secretsDir: dir });
    expect(passwordOf(again.calls)).toBe(passwordOf(first.calls));
  });

  it('a stop while it waits for the database removes the container and returns at once', async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const docker: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'exec') { controller.abort(); return { ok: false, stdout: '' }; }
      return fakeDocker().docker(args);
    };
    const db = await startPreviewDatabase(POSTGRES, { docker, projectId: 'p1', secretsDir: secretsDir(), signal: controller.signal, pollMs: 1 });
    expect(db.status).toBe('unavailable');
    expect(calls.filter((c) => c[0] === 'exec')).toHaveLength(1);
    expect(calls.at(-1)).toEqual(['rm', '-f', 'abc123']);
  });
});

describe("a task's preview database", () => {
  function volumesDocker(volumes: Set<string>) {
    const calls: string[][] = [];
    const docker: DockerRun = async (args) => {
      calls.push(args);
      const [cmd, sub, name] = args;
      if (cmd === 'info') return { ok: true, stdout: '' };
      if (cmd === 'volume' && sub === 'inspect') return { ok: volumes.has(name), stdout: '' };
      if (cmd === 'volume' && sub === 'create') { volumes.add(name); return { ok: true, stdout: name }; }
      if (cmd === 'volume' && sub === 'rm') { for (const v of args.slice(2)) volumes.delete(v); return { ok: true, stdout: '' }; }
      if (cmd === 'volume' && sub === 'ls') return { ok: true, stdout: [...volumes].join('\n') };
      if (cmd === 'ps') return { ok: true, stdout: '' };
      if (cmd === 'run') return { ok: true, stdout: 'abc123\n' };
      if (cmd === 'port') return { ok: true, stdout: '127.0.0.1:55001\n' };
      return { ok: true, stdout: '' };
    };
    return { docker, calls };
  }

  it("starts from a copy of the project's preview data, with its password, and never touches the project's volume", async () => {
    const dir = secretsDir();
    writeFileSync(join(dir, 'p1.json'), JSON.stringify({ passwords: { postgres: 'projectpw' } }));
    const volumes = new Set(['vibe-teamlead-preview-p1-postgres']);
    const { docker, calls } = volumesDocker(volumes);
    const key = previewTaskKey('/p/.vibe-teamlead/worktrees/tasks/023-x');
    const db = await startPreviewDatabase(POSTGRES, { docker, projectId: key, copyFrom: 'p1', secretsDir: dir });
    const copy = calls.find((c) => c[0] === 'run' && c.includes('--entrypoint'))!;
    expect(copy).toEqual(expect.arrayContaining(['-v', 'vibe-teamlead-preview-p1-postgres:/from:ro', '-v', `vibe-teamlead-preview-${key}-postgres:/to`]));
    expect(db.fresh).toBe(false);
    expect(db.started[0]?.url).toContain('verify:projectpw@');
    expect(calls.some((c) => c[0] === 'volume' && c[1] === 'rm' && c.includes('vibe-teamlead-preview-p1-postgres'))).toBe(false);
  });

  it('starts empty when the project has no preview data yet, and copies only once', async () => {
    const volumes = new Set<string>();
    const { docker, calls } = volumesDocker(volumes);
    const key = previewTaskKey('/p/wt/024-y');
    const db = await startPreviewDatabase(POSTGRES, { docker, projectId: key, copyFrom: 'p1', secretsDir: secretsDir() });
    expect(calls.some((c) => c.includes('--entrypoint'))).toBe(false);
    expect(db.fresh).toBe(true);
  });

  it("is removed with the task's worktree", async () => {
    const key = previewTaskKey('/p/wt/023-x');
    const volumes = new Set([`vibe-teamlead-preview-${key}-postgres`, 'vibe-teamlead-preview-p1-postgres']);
    const { docker } = volumesDocker(volumes);
    await removeTaskPreviewVolumes(docker, '/p/wt/023-x');
    expect([...volumes]).toEqual(['vibe-teamlead-preview-p1-postgres']);
  });

  it('keys tasks apart, as plain names docker accepts', () => {
    expect(previewTaskKey('/p/wt/023-x')).toMatch(/^task-[0-9a-f]{12}$/);
    expect(previewTaskKey('/p/wt/023-x')).not.toBe(previewTaskKey('/p/wt/024-y'));
  });
});
