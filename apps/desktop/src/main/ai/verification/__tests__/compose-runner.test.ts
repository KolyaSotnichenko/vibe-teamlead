import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMPOSE_LABEL, composeMovedNotice, createRunNetwork, removeComposeLeftovers, startComposeServices, tcpHolds } from '../compose-runner';
import { composeServices } from '../compose-services';
import type { DockerRun } from '../test-services';

/** The `-p` values of a docker call */
const publishOf = (call: string[]) => call.filter((_, i) => call[i - 1] === '-p');

/** A docker that answers like the real one, and records what it was asked */
function fakeDocker(over: { available?: boolean; failImage?: string; notReady?: boolean; notReadyImage?: string; exited?: boolean; bucketFails?: boolean; bindFails?: boolean } = {}) {
  const calls: string[][] = [];
  let next = 0;
  /** Container port → the host port its run asked for, per container */
  const fixed = new Map<string, Record<string, string>>();
  /** Containers of the image that never gets ready */
  const neverReady = new Set<string>();
  const docker: DockerRun = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'info') return { ok: over.available !== false, stdout: '' };
    if (args[0] === 'ps') return { ok: true, stdout: 'old-one\n' };
    if (args[0] === 'run') {
      if (over.failImage && args.includes(over.failImage)) return { ok: false, stdout: 'manifest unknown' };
      const asked = publishOf(args).map((value) => /^127\.0\.0\.1:(\d+):(\d+)$/.exec(value)).filter((match) => match !== null);
      if (over.bindFails && asked.length) return { ok: false, stdout: 'port is already allocated' };
      const id = `c${++next}`;
      fixed.set(id, Object.fromEntries(asked.map(([, host, container]) => [container, host])));
      if (over.notReadyImage && args.includes(over.notReadyImage)) neverReady.add(id);
      return { ok: true, stdout: `${id}\n` };
    }
    if (args[0] === 'port') {
      const container = args[2].split('/')[0];
      return { ok: true, stdout: `127.0.0.1:${fixed.get(args[1])?.[container] ?? 50000 + (Number(container) % 1000)}\n` };
    }
    if (args[0] === 'exec') return { ok: !(over.notReady || neverReady.has(args[1]) || (over.bucketFails && args.includes('mb'))), stdout: '' };
    if (args[0] === 'inspect') return { ok: true, stdout: over.exited ? 'false\n' : 'true\n' };
    return { ok: true, stdout: '' };
  });
  return { docker, calls };
}

const options = (docker: DockerRun, extra: Partial<Parameters<typeof startComposeServices>[1]> = {}) => ({
  docker, labelKey: 'vibe-teamlead-verify', labelValue: 'proj', readyTimeoutMs: 20, pollMs: 1,
  portOpen: async () => true, pickPort: async () => 41000, secret: () => 'key',
  // The machine's own ports stay out of these tests: no host port is free unless a test says so
  hostPortFree: async () => false, ...extra,
});
const runs = (calls: string[][]) => calls.filter((call) => call[0] === 'run');

describe('startComposeServices', () => {
  it('has nothing to do without services, and asks nothing of Docker', async () => {
    const { docker, calls } = fakeDocker();
    expect((await startComposeServices([], options(docker))).status).toBe('none');
    expect(calls).toEqual([]);
  });

  it('says why when Docker is not running', async () => {
    const { docker } = fakeDocker({ available: false });
    const run = await startComposeServices(composeServices(['services:\n  rabbitmq:\n    image: rabbitmq:3\n']), options(docker));
    expect(run.status).toBe('unavailable');
    expect(run.reason).toMatch(/rabbitmq.*Docker/);
  });

  it('starts each service on its own network, on local ports only, with nothing from the file but safe settings', async () => {
    const { docker, calls } = fakeDocker();
    const services = composeServices([`
services:
  rabbitmq:
    image: rabbitmq:3
    privileged: true
    volumes: ["/:/host"]
    network_mode: host
    environment: { RABBITMQ_DEFAULT_USER: app }
    ports: ["5672:5672"]
`]);
    const run = await startComposeServices(services, options(docker));
    expect(run.status).toBe('started');
    expect(run.started).toEqual([{ name: 'rabbitmq', kind: 'rabbitmq', image: 'rabbitmq:3', ports: { 5672: 50672 }, env: { RABBITMQ_DEFAULT_USER: 'app' } }]);
    const [args] = runs(calls);
    expect(args).toEqual([
      'run', '-d', '--rm', '--label', 'vibe-teamlead-verify=proj', '--label', `${COMPOSE_LABEL}=vibe-teamlead-verify-proj`,
      '--network', 'vibe-teamlead-verify-proj', '--network-alias', 'rabbitmq',
      '-e', 'RABBITMQ_DEFAULT_USER=app', '-p', '127.0.0.1::5672', 'rabbitmq:3',
    ]);
    expect(args.join(' ')).not.toMatch(/--privileged|-v |--volume|--mount|host/);
    expect(calls).toContainEqual(['network', 'create', '--label', 'vibe-teamlead-verify=proj', '--label', `${COMPOSE_LABEL}=vibe-teamlead-verify-proj`, 'vibe-teamlead-verify-proj']);
  });

  it('clears what a run that died left behind, only its own, before starting', async () => {
    const { docker, calls } = fakeDocker();
    await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n']), options(docker));
    expect(calls.find((call) => call[0] === 'ps')?.join(' ')).toContain(`label=${COMPOSE_LABEL}=vibe-teamlead-verify-proj`);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'old-one']);
    expect(calls).toContainEqual(['network', 'rm', 'vibe-teamlead-verify-proj']);
  });

  it('starts dependencies first', async () => {
    const { docker, calls } = fakeDocker();
    await startComposeServices(composeServices(['services:\n  kafka:\n    image: confluentinc/cp-kafka\n    depends_on: [zookeeper]\n  zookeeper:\n    image: confluentinc/cp-zookeeper\n']), options(docker));
    expect(runs(calls).map((args) => args.at(-1))).toEqual(['confluentinc/cp-zookeeper', 'confluentinc/cp-kafka']);
  });

  it('runs Kafka on the host port chosen for it, so it advertises an address clients reach', async () => {
    const { docker, calls } = fakeDocker();
    const run = await startComposeServices(composeServices(['services:\n  kafka:\n    image: apache/kafka:3.7.0\n    ports: ["9092:9092"]\n']), options(docker));
    expect(runs(calls)[0]).toContain('127.0.0.1:41000:41000');
    expect(run.started[0].ports).toEqual({ 9092: 41000, 41000: 41000 });
    expect(run.started[0].env.KAFKA_ADVERTISED_LISTENERS).toBe('PLAINTEXT://127.0.0.1:41000');
  });

  it('waits on the compose healthcheck when there is one, otherwise on the port', async () => {
    const { docker, calls } = fakeDocker();
    const portOpen = vi.fn(async () => true);
    await startComposeServices(composeServices(['services:\n  a:\n    image: nats:2\n    healthcheck: { test: ["CMD", "check"] }\n  b:\n    image: nats:2\n    expose: ["4222"]\n']), options(docker, { portOpen }));
    expect(calls).toContainEqual(['exec', 'c1', 'check']);
    expect(portOpen).toHaveBeenCalledWith(50222);
  });

  it('reports a service that does not come up, empties nothing else, and goes on with the rest', async () => {
    const { docker, calls } = fakeDocker({ failImage: 'nats:2' });
    const run = await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n  rabbitmq:\n    image: rabbitmq:3\n']), options(docker));
    expect(run.status).toBe('started');
    expect(run.started.map((s) => s.name)).toEqual(['rabbitmq']);
    expect(run.failed).toEqual([{ name: 'nats', reason: expect.stringMatching(/Docker could not start nats:2: manifest unknown/) }]);
    expect(runs(calls)).toHaveLength(2);
  });

  it('gives up on a service that is not ready in time, and removes it', async () => {
    const { docker, calls } = fakeDocker();
    const run = await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n    expose: ["4222"]\n']), options(docker, { portOpen: async () => false }));
    expect(run.status).toBe('unavailable');
    expect(run.failed[0].reason).toMatch(/nats.*did not get ready in time/);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'c1']);
  });

  it('notices a service that stopped right after it started', async () => {
    const { docker } = fakeDocker({ exited: true });
    const run = await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n    expose: ["4222"]\n']), options(docker, { portOpen: async () => false, readyTimeoutMs: 10_000 }));
    expect(run.failed[0].reason).toMatch(/stopped/);
  });

  it('does not start what depends on a service that failed', async () => {
    const { docker } = fakeDocker({ failImage: 'confluentinc/cp-zookeeper' });
    const run = await startComposeServices(composeServices(['services:\n  kafka:\n    image: confluentinc/cp-kafka\n    depends_on: [zookeeper]\n  zookeeper:\n    image: confluentinc/cp-zookeeper\n']), options(docker));
    expect(run.failed.map((f) => f.name)).toEqual(['zookeeper', 'kafka']);
    expect(run.failed[1].reason).toMatch(/needs zookeeper/);
  });

  it('creates the buckets the example names in MinIO, with the container\'s keys', async () => {
    const { docker, calls } = fakeDocker();
    await startComposeServices(composeServices(['services:\n  minio:\n    image: minio/minio\n    command: server /data\n    environment:\n      MINIO_ROOT_USER: u\n      MINIO_ROOT_PASSWORD: p@ss\n']), options(docker, { buckets: ['uploads'] }));
    expect(calls).toContainEqual(['exec', '-e', 'MC_HOST_vt=http://u:p%40ss@127.0.0.1:9000', 'c1', 'mc', 'mb', '--ignore-existing', 'vt/uploads']);
  });

  it('creates the buckets in LocalStack with its own tool', async () => {
    const { docker, calls } = fakeDocker();
    await startComposeServices(composeServices(['services:\n  localstack:\n    image: localstack/localstack\n    ports: ["4566:4566"]\n']), options(docker, { buckets: ['uploads'] }));
    expect(calls).toContainEqual(['exec', 'c1', 'awslocal', 's3', 'mb', 's3://uploads']);
  });

  it('reports a bucket it could not create, and keeps the service', async () => {
    const { docker } = fakeDocker({ bucketFails: true });
    const run = await startComposeServices(composeServices(['services:\n  minio:\n    image: minio/minio\n']), options(docker, { buckets: ['uploads'] }));
    expect(run.started.map((s) => s.name)).toEqual(['minio']);
    expect(run.failed[0].reason).toMatch(/bucket uploads/);
  });

  it('removes its containers, then its network', async () => {
    const { docker, calls } = fakeDocker();
    const run = await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n']), options(docker));
    calls.length = 0;
    await run.stop();
    expect(calls).toEqual([['rm', '-f', '-v', 'c1'], ['network', 'rm', 'vibe-teamlead-verify-proj']]);
  });

  it('stops starting when the run is stopped, and removes what it started', async () => {
    const { docker, calls } = fakeDocker();
    const abort = new AbortController();
    abort.abort();
    const run = await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n']), options(docker, { signal: abort.signal }));
    expect(run.status).toBe('unavailable');
    expect(runs(calls)).toHaveLength(0);
  });
});

describe('removeComposeLeftovers', () => {
  it('removes every container and network with the label', async () => {
    const calls: string[][] = [];
    const docker: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'ps') return { ok: true, stdout: 'a\nb\n' };
      if (args[0] === 'network' && args[1] === 'ls') return { ok: true, stdout: 'n1\n' };
      return { ok: true, stdout: '' };
    };
    await removeComposeLeftovers(docker, 'vibe-teamlead-preview');
    expect(calls).toEqual([
      ['ps', '-aq', '--filter', 'label=vibe-teamlead-preview'],
      ['rm', '-f', '-v', 'a'],
      ['rm', '-f', '-v', 'b'],
      ['network', 'ls', '-q', '--filter', 'label=vibe-teamlead-preview'],
      ['network', 'rm', 'n1'],
    ]);
  });
});

describe("a run's network", () => {
  it('is created per run with the run\'s labels, after what a run that died left on it is removed', async () => {
    const { docker, calls } = fakeDocker();
    const network = await createRunNetwork(docker, 'vibe-teamlead-verify', 'proj');
    expect(network?.name).toBe('vibe-teamlead-verify-proj');
    const create = calls.findIndex((c) => c[0] === 'network' && c[1] === 'create');
    expect(calls.slice(0, create)).toEqual([
      ['ps', '-aq', '--filter', 'network=vibe-teamlead-verify-proj'],
      ['rm', '-f', '-v', 'old-one'],
      ['network', 'rm', 'vibe-teamlead-verify-proj'],
    ]);
    // A user-defined bridge: the containers find each other by name, never the host's network
    expect(calls[create]).toEqual(['network', 'create', '--label', 'vibe-teamlead-verify=proj', '--label', `${COMPOSE_LABEL}=vibe-teamlead-verify-proj`, 'vibe-teamlead-verify-proj']);
    await network?.remove();
    expect(calls.at(-1)).toEqual(['network', 'rm', 'vibe-teamlead-verify-proj']);
  });

  it('is none when Docker cannot create it', async () => {
    const docker: DockerRun = async (args) => ({ ok: !(args[0] === 'network' && args[1] === 'create'), stdout: '' });
    expect(await createRunNetwork(docker, 'vibe-teamlead-preview', 'p1')).toBeUndefined();
  });

  it('given to the compose services, is joined and left to its owner: not made, not removed', async () => {
    const { docker, calls } = fakeDocker();
    const run = await startComposeServices(composeServices(['services:\n  keycloak:\n    image: quay.io/keycloak/keycloak:26\n']), options(docker, { network: 'shared-net' }));
    expect(runs(calls)[0].join(' ')).toContain('--network shared-net --network-alias keycloak');
    await run.stop();
    expect(calls.filter((c) => c[0] === 'network')).toEqual([]);
  });
});

describe('tcpHolds', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  const listen = (onConnection: (socket: import('node:net').Socket) => void) =>
    new Promise<number>((resolve) => {
      server = createServer(onConnection);
      server.listen(0, '127.0.0.1', () => resolve((server?.address() as { port: number }).port));
    });

  it('is true for a local port that accepts and keeps the connection', async () => {
    const port = await listen(() => {});
    expect(await tcpHolds(port, 50)).toBe(true);
  });

  it('is false when the connection is closed at once, as Docker\'s proxy does before the service listens', async () => {
    const port = await listen((socket) => socket.destroy());
    expect(await tcpHolds(port, 200)).toBe(false);
  });
});

describe("the compose file's host ports", () => {
  const AZURITE = 'services:\n  azurite:\n    image: mcr.microsoft.com/azure-storage/azurite\n    ports: ["10000:10000", "10001:10001"]\n';

  it('publishes a port on the host port the compose file names when it is free', async () => {
    const { docker, calls } = fakeDocker();
    const hostPortFree = vi.fn(async (port: number) => port === 10000);
    const run = await startComposeServices(composeServices([AZURITE]), options(docker, { hostPortFree }));
    expect(publishOf(runs(calls)[0])).toEqual(['127.0.0.1:10000:10000', '127.0.0.1::10001']);
    expect(run.started[0].ports).toEqual({ 10000: 10000, 10001: 50001 });
    expect(run.moved).toEqual([{ name: 'azurite', wanted: 10001, got: 50001 }]);
  });

  it('starts once more on free ports when Docker refuses the host port', async () => {
    const { docker, calls } = fakeDocker({ bindFails: true });
    const run = await startComposeServices(composeServices([AZURITE]), options(docker, { hostPortFree: async () => true }));
    expect(runs(calls).map(publishOf)).toEqual([['127.0.0.1:10000:10000', '127.0.0.1:10001:10001'], ['127.0.0.1::10000', '127.0.0.1::10001']]);
    expect(run.status).toBe('started');
    expect(run.failed).toEqual([]);
    expect(run.moved).toEqual([{ name: 'azurite', wanted: 10000, got: 50000 }, { name: 'azurite', wanted: 10001, got: 50001 }]);
  });

  it('gives a host port two services name to the first one only, and says who has it', async () => {
    const { docker, calls } = fakeDocker();
    const two = 'services:\n  a:\n    image: nats:2\n    ports: ["4222:4222"]\n  b:\n    image: nats:2\n    ports: ["4222:4222"]\n';
    const run = await startComposeServices(composeServices([two]), options(docker, { hostPortFree: async () => true }));
    expect(runs(calls).map(publishOf)).toEqual([['127.0.0.1:4222:4222'], ['127.0.0.1::4222']]);
    expect(run.moved).toEqual([{ name: 'b', wanted: 4222, got: 50222, heldBy: 'a' }]);
    expect(composeMovedNotice(run.moved[0])).toBe(
      'b runs on port 50222 here: port 4222, which the compose file gives it, is the one a has in this preview. An address the project hard-codes for b reaches a instead.',
    );
  });

  it('gives the port to the next service that names it when the first one did not come up', async () => {
    const { docker, calls } = fakeDocker({ notReadyImage: 'example/broken' });
    const two = 'services:\n  a:\n    image: example/broken\n    ports: ["4222:4222"]\n    healthcheck: { test: ["CMD", "check"] }\n  b:\n    image: nats:2\n    ports: ["4222:4222"]\n';
    const run = await startComposeServices(composeServices([two]), options(docker, { hostPortFree: async () => true }));
    expect(run.failed.map((f) => f.name)).toEqual(['a']);
    expect(runs(calls).map(publishOf)).toEqual([['127.0.0.1:4222:4222'], ['127.0.0.1:4222:4222']]);
    expect(run.moved).toEqual([]);
  });

  it('starts once more on free ports only when Docker refused the port, not for another failure', async () => {
    const { docker, calls } = fakeDocker({ failImage: 'example/missing' });
    const run = await startComposeServices(composeServices(['services:\n  a:\n    image: example/missing\n    ports: ["4222:4222"]\n']), options(docker, { hostPortFree: async () => true }));
    expect(runs(calls)).toHaveLength(1);
    expect(run.failed[0].reason).toMatch(/manifest unknown/);
  });

  it.each(['Bind for 127.0.0.1:4222 failed: port is already allocated', 'listen tcp4 127.0.0.1:4222: bind: address already in use', 'Ports are not available: exposing port TCP 127.0.0.1:4222'])('reads "%s" as a refused port', async (text) => {
    const calls: string[][] = [];
    let n = 0;
    const docker: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'run') return publishOf(args).some((p) => /:4222:4222$/.test(p)) ? { ok: false, stdout: `docker: Error response from daemon: ${text}` } : { ok: true, stdout: `c${++n}\n` };
      if (args[0] === 'port') return { ok: true, stdout: '127.0.0.1:50222\n' };
      if (args[0] === 'inspect') return { ok: true, stdout: 'true\n' };
      return { ok: true, stdout: '' };
    };
    const run = await startComposeServices(composeServices(['services:\n  a:\n    image: nats:2\n    ports: ["4222:4222"]\n']), options(docker, { hostPortFree: async () => true }));
    expect(runs(calls)).toHaveLength(2);
    expect(run.moved).toEqual([{ name: 'a', wanted: 4222, got: 50222 }]);
  });

  it('decides each port of a range on its own', async () => {
    const { docker, calls } = fakeDocker();
    const hostPortFree = vi.fn(async (port: number) => port !== 8001);
    const run = await startComposeServices(composeServices(['services:\n  a:\n    image: example/app\n    ports: ["8000-8002:9000-9002"]\n']), options(docker, { hostPortFree }));
    expect(publishOf(runs(calls)[0])).toEqual(['127.0.0.1:8000:9000', '127.0.0.1::9001', '127.0.0.1:8002:9002']);
    expect(run.moved).toEqual([{ name: 'a', wanted: 8001, got: 50001 }]);
  });

  it('asks about no port and moves nothing for a service that publishes no host port', async () => {
    const { docker } = fakeDocker();
    const hostPortFree = vi.fn(async () => true);
    const run = await startComposeServices(composeServices(['services:\n  nats:\n    image: nats:2\n    expose: ["4222"]\n']), options(docker, { hostPortFree }));
    expect(hostPortFree).not.toHaveBeenCalled();
    expect(run.moved).toEqual([]);
  });

  it('leaves a kind that needs its host port first on the port the app picks, and reports nothing moved', async () => {
    const { docker } = fakeDocker();
    const run = await startComposeServices(composeServices(['services:\n  kafka:\n    image: apache/kafka:3.7.0\n    ports: ["9092:9092"]\n']), options(docker, { hostPortFree: async () => true }));
    expect(run.started[0].ports[9092]).toBe(41000);
    expect(run.moved).toEqual([]);
  });

  it('takes no host port from the compose file unless the caller says which are free', async () => {
    const { docker, calls } = fakeDocker();
    const run = await startComposeServices(composeServices([AZURITE]), { ...options(docker), hostPortFree: undefined });
    expect(publishOf(runs(calls)[0])).toEqual(['127.0.0.1::10000', '127.0.0.1::10001']);
    expect(run.moved).toEqual([]);
  });

  it('leaves a host port below 1024 alone: no question, no fixed port, no notice', async () => {
    const { docker, calls } = fakeDocker();
    const hostPortFree = vi.fn(async () => true);
    const run = await startComposeServices(composeServices(['services:\n  proxy:\n    image: example/gateway\n    ports: ["80:8080", "8443:8443"]\n']), options(docker, { hostPortFree }));
    expect(publishOf(runs(calls)[0])).toEqual(['127.0.0.1::8080', '127.0.0.1:8443:8443']);
    expect(hostPortFree.mock.calls).toEqual([[8443]]);
    expect(run.moved).toEqual([]);
  });

  it('says in plain words which address misses a moved service', () => {
    expect(composeMovedNotice({ name: 'azurite', wanted: 10000, got: 50000 })).toBe(
      'azurite runs on port 50000 here: port 10000, which the compose file gives it, is taken by something else on this computer. An address the project hard-codes for azurite reaches that instead.',
    );
  });
});
