/**
 * The compose file's infrastructure services as throwaway containers, for one preview session
 * or one check run: on the run's network, with its databases (so they find each other by
 * their compose names), each port published on 127.0.0.1 only, nothing mounted, removed afterwards. For
 * a caller that says which host ports are free (the preview; app checks don't, so two runs never
 * compete for one), a port the compose file publishes goes on that same host port, so an address
 * the project or a library hard-codes (Azurite's 127.0.0.1:10000) reaches the container; a taken
 * one gets a free port, and the run says which ports moved. A service is ready when its compose healthcheck passes, or else when its port holds a
 * connection; one that doesn't come up is reported and the rest go on. Buckets the example
 * settings name are created in S3 stand-ins. Leftovers of a run that died are removed by
 * label first. No Electron imports: docker is passed in.
 */

import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';

import { adapterOf, type ComposeService, composeRunArgs, containerSpec, dependencyOrder, type StartedComposeService } from './compose-services';
import { say } from '../../say';
import type { DockerRun } from './test-services';

/** On every compose container and network, with the run's key: what a run that died left is found by it */
export const COMPOSE_LABEL = 'vibe-teamlead-compose';
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const REASON_CHARS = 200;
/** A connection Docker's port proxy accepts while nothing listens is closed at once */
const HOLD_MS = 300;

export interface ComposeRun {
  status: 'none' | 'started' | 'unavailable';
  started: StartedComposeService[];
  /** Each service that didn't come up (or a bucket that couldn't be made), in words a user can act on */
  failed: Array<{ name: string; reason: string }>;
  /** Why none could start (Docker isn't running) */
  reason?: string;
  /** Each port the compose file publishes on `wanted` that this run had to publish on `got` */
  moved: ComposeMovedPort[];
  stop: () => Promise<void>;
}

export interface ComposeMovedPort {
  name: string;
  wanted: number;
  got: number;
  /** The service of this same run that has the port, when it is one of them and not something else on the computer */
  heldBy?: string;
}

/** Docker saying the host port could not be had (taken between the check and the bind), not some other failure */
const PORT_REFUSED = /port is already allocated|address already in use|ports are not available|failed to bind|bind for/i;

export interface ComposeRunOptions {
  docker: DockerRun;
  /** The label the run's other containers have (`vibe-teamlead-verify`, `vibe-teamlead-preview`) and its value */
  labelKey: string;
  labelValue: string;
  /**
   * The run's network (createRunNetwork), which the run's databases are on too: the services
   * join it and leave it to its owner. Without it they get a network of their own.
   */
  network?: string;
  /** Buckets to create in an S3 stand-in */
  buckets?: string[];
  /** A free local port, for a service that must know its host port before it starts (Kafka) */
  pickPort?: () => Promise<number>;
  /** Whether a local port accepts a connection and keeps it */
  portOpen?: (port: number) => Promise<boolean>;
  /**
   * Whether a host port the compose file names may be taken for its service. Without it every
   * port is published on a free one and nothing is reported as moved.
   */
  hostPortFree?: (port: number) => Promise<boolean>;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  pollMs?: number;
  secret?: () => string;
}

/** Whether 127.0.0.1:port accepts a connection and doesn't close it at once */
export function tcpHolds(port: number, holdMs = HOLD_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
    socket.once('end', () => done(false));
    socket.once('connect', () => setTimeout(() => done(true), holdMs));
  });
}

/** A free local port: a server on port 0, closed at once */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A host port this process could take: below 1024 the system keeps them, so they are never asked for or reported */
const ownable = (port: number | undefined): port is number => port !== undefined && port >= 1024;

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const runKey = (labelKey: string, labelValue: string) => `${labelKey}-${labelValue}`.replace(/[^\w.-]/g, '_');

/** Containers (with their anonymous volumes) and networks of compose runs left behind, by labels they all have */
export async function removeComposeLeftovers(docker: DockerRun, labels: string | string[]): Promise<void> {
  const filters = [labels].flat().flatMap((label) => ['--filter', `label=${label}`]);
  for (const id of lines((await docker(['ps', '-aq', ...filters])).stdout)) await docker(['rm', '-f', '-v', id]);
  for (const id of lines((await docker(['network', 'ls', '-q', ...filters])).stdout)) await docker(['network', 'rm', id]);
}

export interface RunNetwork {
  name: string;
  remove: () => Promise<void>;
}

/**
 * One user-defined network for every throwaway container of a run (a preview session or a check
 * run), named and labelled after the run: each container joins it under its compose service's
 * name, so they reach each other as in compose. What a run that died left on it goes first.
 * None when Docker can't create it.
 */
export async function createRunNetwork(docker: DockerRun, labelKey: string, labelValue: string): Promise<RunNetwork | undefined> {
  const name = runKey(labelKey, labelValue);
  for (const id of lines((await docker(['ps', '-aq', '--filter', `network=${name}`])).stdout)) await docker(['rm', '-f', '-v', id]);
  await docker(['network', 'rm', name]);
  const created = await docker(['network', 'create', '--label', `${labelKey}=${labelValue}`, '--label', `${COMPOSE_LABEL}=${name}`, name]);
  if (!created.ok) return undefined;
  return { name, remove: async () => { await docker(['network', 'rm', name]); } };
}

/** Why the services can't start without Docker, in words a user can act on */
export function composeDockerMissing(services: ComposeService[]): string {
  const names = services.map((s) => s.name).join(', ');
  return say('composeDockerMissing', `This project's compose file names ${names}, and Docker isn't running. Install or start Docker Desktop to have them started.`, { names });
}

/** What the owner is told when a service could not have the port its compose file gives it */
export function composeMovedNotice({ name, wanted, got, heldBy }: ComposeMovedPort): string {
  if (heldBy) {
    return say('composeMovedSibling', `${name} runs on port ${got} here: port ${wanted}, which the compose file gives it, is the one ${heldBy} has in this preview. An address the project hard-codes for ${name} reaches ${heldBy} instead.`, { name, wanted, got, heldBy });
  }
  return say('composeMoved', `${name} runs on port ${got} here: port ${wanted}, which the compose file gives it, is taken by something else on this computer. An address the project hard-codes for ${name} reaches that instead.`, { name, wanted, got });
}

async function setUpBuckets(docker: DockerRun, id: string, started: StartedComposeService, buckets: string[], deadline: number, pollMs: number): Promise<string[]> {
  const failed: string[] = [];
  for (const bucket of buckets) {
    let args: string[];
    if (/localstack/.test(started.image)) {
      args = ['exec', id, 'awslocal', 's3', 'mb', `s3://${bucket}`];
    } else {
      const credentials = adapterOf('s3').credentials?.(started.env, started.image);
      const auth = `${encodeURIComponent(credentials?.user ?? '')}:${encodeURIComponent(credentials?.password ?? '')}`;
      args = ['exec', '-e', `MC_HOST_vt=http://${auth}@127.0.0.1:9000`, id, 'mc', 'mb', '--ignore-existing', `vt/${bucket}`];
    }
    // Right after its port opens, the store may still be starting up
    let made = (await docker(args)).ok;
    while (!made && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      made = (await docker(args)).ok;
    }
    if (!made) failed.push(bucket);
  }
  return failed;
}

export async function startComposeServices(services: ComposeService[], options: ComposeRunOptions): Promise<ComposeRun> {
  const {
    docker, labelKey, labelValue, network: shared, buckets = [], signal,
    pickPort = freePort, portOpen = (port: number) => tcpHolds(port), hostPortFree,
    readyTimeoutMs = READY_TIMEOUT_MS, pollMs = POLL_MS, secret = () => randomBytes(16).toString('hex'),
  } = options;
  const nothing = async () => {};
  if (!services.length) return { status: 'none', started: [], failed: [], moved: [], stop: nothing };
  if (!(await docker(['info'])).ok) return { status: 'unavailable', started: [], failed: [], moved: [], reason: composeDockerMissing(services), stop: nothing };

  const key = runKey(labelKey, labelValue);
  const labels = [`${labelKey}=${labelValue}`, `${COMPOSE_LABEL}=${key}`];
  const network = shared ?? key;
  // A run that died can't clean up after itself; only this run's key: other projects' runs go on
  if (shared) {
    for (const id of lines((await docker(['ps', '-aq', '--filter', `label=${COMPOSE_LABEL}=${key}`])).stdout)) await docker(['rm', '-f', '-v', id]);
  } else {
    await removeComposeLeftovers(docker, `${COMPOSE_LABEL}=${key}`);
    await docker(['network', 'rm', network]);
    const created = await docker(['network', 'create', ...labels.flatMap((label) => ['--label', label]), network]);
    if (!created.ok) {
      const output = created.stdout.trim().slice(0, REASON_CHARS);
      return { status: 'unavailable', started: [], failed: [], moved: [], reason: say('composeNetworkFailed', `Docker could not create a network for the services: ${output}`, { output }), stop: nothing };
    }
  }

  const ids: string[] = [];
  const stop = async () => {
    for (const id of ids.splice(0)) await docker(['rm', '-f', '-v', id]);
    if (!shared) await docker(['network', 'rm', network]);
  };
  const started: StartedComposeService[] = [];
  const failed: ComposeRun['failed'] = [];
  const moved: ComposeMovedPort[] = [];
  /** Host ports this run has given out, and to whom: a second service naming one gets another */
  const given = new Map<number, string>();
  const remove = async (id: string) => {
    ids.splice(ids.indexOf(id), 1);
    await docker(['rm', '-f', '-v', id]);
  };

  for (const service of dependencyOrder(services)) {
    if (signal?.aborted) break;
    const missing = service.dependsOn.find((dep) => failed.some((f) => f.name === dep));
    if (missing) {
      failed.push({ name: service.name, reason: say('composeNeeds', `${service.name} needs ${missing}, which did not start.`, { name: service.name, missing }) });
      continue;
    }
    const adapter = adapterOf(service.kind);
    const hostPort = adapter.fixedHostPort ? await pickPort() : undefined;
    // The compose file's own host port for each port it publishes, when nothing holds it
    const hostPorts: Record<number, number> = {};
    const wanted = hostPortFree && !adapter.fixedHostPort ? service.ports.filter((p): p is { container: number; host: number } => ownable(p.host)) : [];
    for (const { container, host } of wanted) {
      if (given.has(host) || !(await hostPortFree?.(host))) continue;
      hostPorts[container] = host;
      given.set(host, service.name);
    }
    /** The ports this service was given go back: it does not have them after all */
    const giveBack = () => {
      for (const host of Object.values(hostPorts)) if (given.get(host) === service.name) given.delete(host);
    };
    let spec = containerSpec(service, { hostPort, hostPorts, secret });
    let run = await docker(composeRunArgs(service, spec, { labels, network }));
    // Taken between the check and Docker's bind: once more, on free ports. Any other failure is the service's.
    if (!run.ok && Object.keys(hostPorts).length && PORT_REFUSED.test(run.stdout)) {
      giveBack();
      spec = containerSpec(service, { hostPort, secret });
      run = await docker(composeRunArgs(service, spec, { labels, network }));
    }
    const id = lines(run.stdout).pop() ?? '';
    if (!run.ok || !id) {
      giveBack();
      const output = run.stdout.trim().slice(0, REASON_CHARS);
      failed.push({ name: service.name, reason: say('dockerNotStarted', `Docker could not start ${service.image}: ${output}`, { image: service.image, output }) });
      continue;
    }
    ids.push(id);

    const ports: Record<number, number> = {};
    if (hostPort) {
      for (const p of [...service.ports.map((x) => x.container), ...adapter.ports, hostPort]) ports[p] = hostPort;
    } else {
      for (const { container } of spec.publish) {
        const published = Number(lines((await docker(['port', id, `${container}/tcp`])).stdout)[0]?.split(':').pop());
        if (published) ports[container] = published;
      }
    }
    if (spec.publish.length && !Object.keys(ports).length) {
      giveBack();
      await remove(id);
      failed.push({ name: service.name, reason: say('dockerNoPort', `Docker gave no port for ${service.image}.`, { image: service.image }) });
      continue;
    }

    const firstPort = Object.values(ports)[0];
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    let exited = false;
    while (!ready && !exited && Date.now() < deadline && !signal?.aborted) {
      ready = service.healthcheck
        ? (await docker(['exec', id, ...service.healthcheck])).ok
        : firstPort
          ? await portOpen(firstPort)
          : (await docker(['inspect', '--format', '{{.State.Running}}', id])).stdout.trim() === 'true';
      if (ready) break;
      exited = (await docker(['inspect', '--format', '{{.State.Running}}', id])).stdout.trim() !== 'true';
      if (!exited) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!ready) {
      giveBack();
      await remove(id);
      if (signal?.aborted) break;
      const values = { name: service.name, image: service.image };
      failed.push({
        name: service.name,
        reason: exited
          ? say('composeStoppedAtStart', `${service.name} (${service.image}) stopped right after it started.`, values)
          : say('composeNotReady', `${service.name} (${service.image}) did not get ready in time.`, values),
      });
      continue;
    }
    const startedService: StartedComposeService = { name: service.name, kind: service.kind, image: service.image, ports, env: spec.env };
    started.push(startedService);
    for (const { container, host } of wanted) {
      const got = ports[container];
      if (!got || got === host) continue;
      const holder = given.get(host);
      moved.push({ name: service.name, wanted: host, got, ...(holder && holder !== service.name ? { heldBy: holder } : {}) });
    }
    if (service.kind === 's3' && buckets.length) {
      const missed = await setUpBuckets(docker, id, startedService, buckets, Date.now() + readyTimeoutMs, pollMs);
      for (const bucket of missed) failed.push({ name: service.name, reason: say('composeBucketFailed', `The bucket ${bucket} could not be created in ${service.name}.`, { bucket, name: service.name }) });
    }
  }

  if (signal?.aborted) {
    await stop();
    return { status: 'unavailable', started: [], failed, moved: [], reason: say('runStopped', 'The run was stopped.'), stop: nothing };
  }
  if (!started.length) {
    await stop();
    return { status: 'unavailable', started: [], failed, moved: [], reason: failed.map((f) => f.reason).join(' '), stop: nothing };
  }
  return { status: 'started', started, failed, moved, stop };
}
