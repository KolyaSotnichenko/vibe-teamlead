import { describe, expect, it, vi } from 'vitest';

import { startTestServices, type DockerRun } from '../test-services';

/** A docker that answers like the real one, and records what it was asked */
function fakeDocker(over: { available?: boolean; pullFails?: boolean; notReady?: boolean } = {}) {
  const calls: string[][] = [];
  const docker: DockerRun = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'info') return { ok: over.available !== false, stdout: '' };
    if (args[0] === 'ps') return { ok: true, stdout: 'old-container\n' };
    if (args[0] === 'run') return over.pullFails ? { ok: false, stdout: 'pull access denied' } : { ok: true, stdout: 'abc123\n' };
    if (args[0] === 'port') return { ok: true, stdout: '127.0.0.1:50000\n' };
    if (args[0] === 'exec') return { ok: !over.notReady, stdout: '' };
    return { ok: true, stdout: '' };
  });
  return { docker, calls };
}

const options = (docker: DockerRun) => ({ docker, label: 'proj', readyTimeoutMs: 20, pollMs: 1 });
const run = (calls: string[][]) => calls.find((call) => call[0] === 'run') ?? [];

describe('startTestServices', () => {
  it('starts a throwaway database and gives its address', async () => {
    const { docker } = fakeDocker();
    const services = await startTestServices([{ kind: 'postgres', image: 'postgres:18-alpine' }], options(docker));
    expect(services.status).toBe('started');
    expect(services.started[0].kind).toBe('postgres');
    expect(services.started[0].url).toMatch(/^postgresql:\/\/verify:[a-f0-9]+@127\.0\.0\.1:50000\/verify$/);
  });

  it('asks only for a database: local port, no mounts, no privileges, a fresh password', async () => {
    const { docker, calls } = fakeDocker();
    await startTestServices([{ kind: 'postgres', image: 'postgres:18-alpine' }], options(docker));
    const args = run(calls);
    expect(args).toContain('127.0.0.1::5432');
    expect(args.join(' ')).not.toMatch(/--privileged|-v |--volume|--network|--mount/);
    expect(args).toContain('--rm');
    expect(args.at(-1)).toBe('postgres:18-alpine');
  });

  it('removes what it started', async () => {
    const { docker, calls } = fakeDocker();
    const services = await startTestServices([{ kind: 'redis', image: 'redis:7' }], options(docker));
    await services.stop();
    expect(calls).toContainEqual(['rm', '-f', '-v', 'abc123']);
  });

  it('clears what a run that died left, and only its own', async () => {
    const { docker, calls } = fakeDocker();
    await startTestServices([{ kind: 'redis', image: 'redis:7' }], options(docker));
    expect(calls.find((call) => call[0] === 'ps')?.join(' ')).toContain('label=vibe-teamlead-verify=proj');
    expect(calls).toContainEqual(['rm', '-f', '-v', 'old-container']);
  });

  it('has nothing to do for a project without services, and asks nothing of Docker', async () => {
    const { docker, calls } = fakeDocker();
    expect((await startTestServices([], options(docker))).status).toBe('none');
    expect(calls).toEqual([]);
  });

  it('without Docker, says so in plain words', async () => {
    const { docker } = fakeDocker({ available: false });
    const services = await startTestServices([{ kind: 'postgres', image: 'postgres:18' }], options(docker));
    expect(services.status).toBe('unavailable');
    expect(services.reason).toMatch(/Docker/);
  });

  it('an image that cannot start is a reason, not an exception', async () => {
    const { docker } = fakeDocker({ pullFails: true });
    const services = await startTestServices([{ kind: 'postgres', image: 'postgres:18' }], options(docker));
    expect(services.status).toBe('unavailable');
    expect(services.reason).toMatch(/pull access denied/);
  });

  it('a database that never gets ready is stopped, and is a reason', async () => {
    const { docker, calls } = fakeDocker({ notReady: true });
    const services = await startTestServices([{ kind: 'postgres', image: 'postgres:18' }], options(docker));
    expect(services.status).toBe('unavailable');
    expect(calls).toContainEqual(['rm', '-f', '-v', 'abc123']);
  });
});
