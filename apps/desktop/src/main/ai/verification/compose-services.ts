/**
 * The infrastructure a project's compose files name besides its databases: queues, storage,
 * search… Only the image and safe settings are taken from a file that could ask for anything:
 * the environment's values (never `env_file`, never the host's values), the command and
 * entrypoint, the container ports and the healthcheck. Never volumes, privileges, devices,
 * the host's network or namespaces, a user or extra hosts. A service with `build:` is the
 * project's own code and is left alone; the databases test-services.ts starts are left to it.
 * A few kinds need small adjustments to run as a throwaway that clients outside the
 * container can reach (Kafka's advertised listener, search engines without security). Pure.
 */

import { load } from 'js-yaml';

export type ComposeKind = 'generic' | 's3' | 'rabbitmq' | 'kafka' | 'redpanda' | 'elasticsearch' | 'opensearch' | 'meilisearch' | 'typesense';

export interface ComposePort {
  container: number;
  /** The host port compose publishes it on, which local addresses in the examples use */
  host?: number;
}

export interface ComposeService {
  name: string;
  image: string;
  kind: ComposeKind;
  env: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  ports: ComposePort[];
  /** What to run in the container to see it is ready */
  healthcheck?: string[];
  dependsOn: string[];
}

/** A compose service as started: its container ports on 127.0.0.1, and the environment it got */
export interface StartedComposeService {
  name: string;
  kind: ComposeKind;
  image: string;
  /** Container port → host port on 127.0.0.1 */
  ports: Record<number, number>;
  env: Record<string, string>;
}

const SAFE_IMAGE = /^[A-Za-z0-9][\w./:@-]*$/;
const SERVICE_NAME = /^[A-Za-z0-9][\w.-]*$/;
const ENV_NAME = /^[A-Za-z_][\w.-]*$/;
/** test-services.ts starts these, with its own recipes */
export const DATABASE_IMAGE = /postgres|pgvector|postgis|timescale|mysql|mariadb|redis|valkey|mongo/;
/**
 * Not infrastructure the app talks to: viewers of other services, mail catchers (the preview
 * runs its own) and proxies in front of the project's own containers
 */
const TOOL_IMAGE = /adminer|pgadmin|phpmyadmin|redis-?commander|redisinsight|kafka-ui|kafdrop|akhq|portainer|dozzle|kibana|dashboards|mailhog|mailpit|maildev|smtp4dev|nginx|traefik|caddy|haproxy|envoyproxy|(^|\/)httpd(:|$)/;
const MAX_PORT_RANGE = 10;

const KINDS: [RegExp, ComposeKind][] = [
  [/minio|localstack/, 's3'],
  [/rabbitmq/, 'rabbitmq'],
  [/redpanda/, 'redpanda'],
  [/(^|\/)(cp-)?kafka(-native)?(:|@|$)/, 'kafka'],
  [/elasticsearch/, 'elasticsearch'],
  [/opensearch/, 'opensearch'],
  [/meilisearch/, 'meilisearch'],
  [/typesense/, 'typesense'],
];

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const scalar = (value: unknown): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** Compose's `${NAME}` without the `.env` it reads them from (never read): only the defaults the file itself gives */
export function interpolate(text: string): string {
  return text.replace(/\$\$|\$\{([A-Za-z_]\w*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_]\w*)/g, (match, _name, op: string | undefined, arg: string | undefined) => {
    if (match === '$$') return '$';
    return op === ':-' || op === '-' ? (arg ?? '') : '';
  });
}

/** A command line split the way a shell splits words, without running anything */
function words(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

function argv(value: unknown): string[] | undefined {
  if (typeof value === 'string') return words(interpolate(value));
  if (Array.isArray(value) && value.every(scalar)) return value.map((part) => interpolate(String(part)));
  return undefined;
}

function envOf(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = typeof entry === 'string' ? /^([^=]+)=(.*)$/s.exec(entry) : null;
      // `NAME` alone passes the host's value through: never
      if (match && ENV_NAME.test(match[1])) env[match[1]] = interpolate(match[2]);
    }
  } else {
    for (const [name, raw] of Object.entries(record(value))) if (ENV_NAME.test(name) && scalar(raw)) env[name] = interpolate(String(raw));
  }
  return env;
}

const validPort = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;

function portsOf(ports: unknown, expose: unknown): ComposePort[] {
  const out: ComposePort[] = [];
  const add = (container: number, host?: number) => {
    if (!validPort(container) || out.some((p) => p.container === container)) return;
    out.push(host !== undefined && validPort(host) ? { container, host } : { container });
  };
  const range = (text: string) => {
    const [from, to = from] = text.split('-').map(Number);
    return { from, count: Math.min(Math.max(to - from + 1, 1), MAX_PORT_RANGE) };
  };
  for (const entry of list(ports)) {
    if (entry && typeof entry === 'object') {
      const long = record(entry);
      if (String(long.protocol ?? 'tcp') !== 'tcp') continue;
      add(Number(long.target), long.published === undefined ? undefined : Number(String(long.published).split('-')[0]));
      continue;
    }
    if (!scalar(entry)) continue;
    const [spec, protocol = 'tcp'] = interpolate(String(entry)).split('/');
    if (protocol !== 'tcp') continue;
    const parts = spec.split(':');
    const container = range(parts[parts.length - 1]);
    const host = parts.length > 1 && parts[parts.length - 2] ? range(parts[parts.length - 2]) : undefined;
    for (let i = 0; i < container.count; i++) add(container.from + i, host ? host.from + i : undefined);
  }
  for (const entry of list(expose)) {
    if (!scalar(entry)) continue;
    const [spec, protocol = 'tcp'] = String(entry).split('/');
    if (protocol !== 'tcp') continue;
    const { from, count } = range(spec);
    for (let i = 0; i < count; i++) add(from + i);
  }
  return out;
}

function healthcheckOf(value: unknown): string[] | undefined {
  const health = record(value);
  if (health.disable === true) return undefined;
  if (typeof health.test === 'string') return health.test.trim() ? ['sh', '-c', interpolate(health.test)] : undefined;
  if (!Array.isArray(health.test) || !health.test.every(scalar)) return undefined;
  const [kind, ...rest] = health.test.map((part) => interpolate(String(part)));
  if (kind === 'CMD' && rest.length) return rest;
  if (kind === 'CMD-SHELL' && rest.length) return ['sh', '-c', rest.join(' ')];
  return undefined;
}

/** The kind of service an image is, by its name */
export function composeKindOf(image: string): ComposeKind {
  return KINDS.find(([pattern]) => pattern.test(image.toLowerCase()))?.[1] ?? 'generic';
}

/**
 * The services to start from the project's compose files, the main one first and the overrides
 * merged onto it. Each with an image and no build, not behind a profile, not a database. Pure.
 */
export function composeServices(contents: string[]): ComposeService[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const content of contents) {
    let parsed: unknown;
    try {
      parsed = load(content);
    } catch {
      continue;
    }
    for (const [name, raw] of Object.entries(record(record(parsed).services))) {
      const service = record(raw);
      const before = merged.get(name) ?? {};
      merged.set(name, { ...before, ...service, environment: { ...envOf(before.environment), ...envOf(service.environment) } });
    }
  }
  const services: ComposeService[] = [];
  for (const [name, raw] of merged) {
    const image = typeof raw.image === 'string' ? raw.image.trim() : '';
    if (!image || raw.build !== undefined || !SAFE_IMAGE.test(image) || !SERVICE_NAME.test(name)) continue;
    if (list(raw.profiles).length || raw.scale === 0 || record(raw.deploy).replicas === 0) continue;
    const lower = image.toLowerCase();
    if (DATABASE_IMAGE.test(lower) || TOOL_IMAGE.test(lower)) continue;
    const command = argv(raw.command);
    const entrypoint = argv(raw.entrypoint);
    const healthcheck = healthcheckOf(raw.healthcheck);
    const dependsOn = Array.isArray(raw.depends_on) ? raw.depends_on.filter((d): d is string => typeof d === 'string') : Object.keys(record(raw.depends_on));
    services.push({
      name,
      image,
      kind: composeKindOf(image),
      env: envOf(raw.environment),
      ...(command?.length ? { command } : {}),
      ...(entrypoint?.length ? { entrypoint } : {}),
      ports: portsOf(raw.ports, raw.expose),
      ...(healthcheck ? { healthcheck } : {}),
      dependsOn,
    });
  }
  return services;
}

/** What a service depends on starts before it; a cycle or an unknown name doesn't stop the rest. Pure. */
export function dependencyOrder(services: ComposeService[]): ComposeService[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const out: ComposeService[] = [];
  const seen = new Set<string>();
  const visit = (service: ComposeService) => {
    if (seen.has(service.name)) return;
    seen.add(service.name);
    for (const dep of service.dependsOn) {
      const other = byName.get(dep);
      if (other) visit(other);
    }
    out.push(service);
  };
  for (const service of services) visit(service);
  return out;
}

/** Valid S3 bucket names the example settings name (`S3_BUCKET`, `AWS_BUCKET_NAME`). Pure. */
export function bucketsOf(example: string): string[] {
  const found: string[] = [];
  for (const line of example.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || !/BUCKET(_NAME)?$/i.test(match[1])) continue;
    const value = match[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    if (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) && !found.includes(value)) found.push(value);
  }
  return found;
}

export interface Credentials {
  user: string;
  password: string;
}

interface Adapter {
  /** The ports the image listens on, when compose names none */
  ports: number[];
  /** Words in a setting's name that say it is about this kind (RABBITMQ_HOST, ES_URL) */
  aliases: string[];
  /** Runs without TLS as a throwaway: https addresses to it become http */
  plainHttp?: boolean;
  /** Clients must reach it at the address it advertises: its host port is chosen before it starts */
  fixedHostPort?: boolean;
  /** The container's environment and command, adjusted to run as a throwaway */
  adjust?: (spec: { env: Record<string, string>; command?: string[]; image: string }, context: { hostPort?: number; secret: () => string }) => void;
  /** The user and password (or key) the container was started with; undefined to keep the example's */
  credentials?: (env: Record<string, string>, image: string) => Credentials | undefined;
}

const JAVA_HEAP = '-Xms512m -Xmx512m';

/** The external listener of a `NAME://host:port,…` list: the one on localhost, else the first */
function externalIndex(entries: string[]): number {
  const local = entries.findIndex((entry) => /^(?:[\w-]+:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)?:\d+$/.test(entry) && /(localhost|127\.0\.0\.1)/.test(entry));
  return local >= 0 ? local : 0;
}

const listenerName = (entry: string) => /^([\w-]+):\/\//.exec(entry)?.[1];
const withAddress = (entry: string, address: string) => (listenerName(entry) ? `${listenerName(entry)}://${address}` : address);

function adjustKafka(spec: { env: Record<string, string>; image: string }, hostPort: number): void {
  const prefix = Object.keys(spec.env).some((name) => name.startsWith('KAFKA_CFG_')) || /bitnami/.test(spec.image) ? 'KAFKA_CFG_' : 'KAFKA_';
  const advertisedKey = `${prefix}ADVERTISED_LISTENERS`;
  const listenersKey = `${prefix}LISTENERS`;
  const advertised = spec.env[advertisedKey];
  if (advertised) {
    const entries = advertised.split(',').map((entry) => entry.trim()).filter(Boolean);
    const index = externalIndex(entries);
    const name = listenerName(entries[index]);
    entries[index] = withAddress(entries[index], `127.0.0.1:${hostPort}`);
    spec.env[advertisedKey] = entries.join(',');
    const listeners = (spec.env[listenersKey] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    const at = listeners.findIndex((entry) => listenerName(entry) === name);
    if (at >= 0) listeners[at] = withAddress(listeners[at], `0.0.0.0:${hostPort}`);
    else listeners.push(name ? `${name}://0.0.0.0:${hostPort}` : `PLAINTEXT://0.0.0.0:${hostPort}`);
    spec.env[listenersKey] = listeners.join(',');
    return;
  }
  // Nothing about listeners: one node that is its own controller
  Object.assign(spec.env, {
    [`${prefix}NODE_ID`]: '1',
    [`${prefix}PROCESS_ROLES`]: 'broker,controller',
    [listenersKey]: `PLAINTEXT://0.0.0.0:${hostPort},CONTROLLER://0.0.0.0:9093`,
    [advertisedKey]: `PLAINTEXT://127.0.0.1:${hostPort}`,
    [`${prefix}CONTROLLER_LISTENER_NAMES`]: 'CONTROLLER',
    [`${prefix}LISTENER_SECURITY_PROTOCOL_MAP`]: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
    [`${prefix}CONTROLLER_QUORUM_VOTERS`]: '1@localhost:9093',
    [`${prefix}OFFSETS_TOPIC_REPLICATION_FACTOR`]: '1',
    [`${prefix}TRANSACTION_STATE_LOG_REPLICATION_FACTOR`]: '1',
    [`${prefix}TRANSACTION_STATE_LOG_MIN_ISR`]: '1',
    ...(/confluentinc/.test(spec.image) ? { CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk' } : {}),
  });
}

/** Redpanda says where it listens and what it advertises on its command line */
function adjustRedpanda(spec: { command?: string[] }, hostPort: number): void {
  const command = spec.command ?? [];
  const flag = (name: string) => {
    const at = command.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (at < 0) return undefined;
    const inline = command[at].startsWith(`${name}=`);
    return { at: inline ? at : at + 1, inline, prefix: inline ? `${name}=` : '' };
  };
  const advertise = flag('--advertise-kafka-addr');
  const listen = flag('--kafka-addr');
  if (!advertise || !command[advertise.at]) {
    const kept = listen ? command.filter((_arg, index) => index !== listen.at && (listen.inline || index !== listen.at - 1)) : command;
    spec.command = [
      ...(kept.length ? kept : ['redpanda', 'start', '--mode', 'dev-container', '--smp', '1']),
      '--kafka-addr', `0.0.0.0:${hostPort}`, '--advertise-kafka-addr', `127.0.0.1:${hostPort}`,
    ];
    return;
  }
  const entries = command[advertise.at].slice(advertise.prefix.length).split(',');
  const index = externalIndex(entries);
  const name = listenerName(entries[index]);
  entries[index] = withAddress(entries[index], `127.0.0.1:${hostPort}`);
  command[advertise.at] = `${advertise.prefix}${entries.join(',')}`;
  if (listen && command[listen.at]) {
    const listeners = command[listen.at].slice(listen.prefix.length).split(',');
    const at = name ? listeners.findIndex((entry) => listenerName(entry) === name) : index;
    if (at >= 0 && listeners[at]) listeners[at] = withAddress(listeners[at], `0.0.0.0:${hostPort}`);
    command[listen.at] = `${listen.prefix}${listeners.join(',')}`;
  }
  spec.command = command;
}

const ADAPTERS: Record<ComposeKind, Adapter> = {
  generic: { ports: [], aliases: [] },
  s3: {
    ports: [9000],
    aliases: ['S3', 'MINIO', 'LOCALSTACK', 'STORAGE', 'AWS'],
    credentials: (env, image) =>
      /localstack/.test(image)
        ? { user: 'test', password: 'test' }
        : {
          user: env.MINIO_ROOT_USER || env.MINIO_ACCESS_KEY || 'minioadmin',
          password: env.MINIO_ROOT_PASSWORD || env.MINIO_SECRET_KEY || 'minioadmin',
        },
  },
  rabbitmq: {
    ports: [5672],
    aliases: ['RABBITMQ', 'RABBIT', 'AMQP'],
    credentials: (env) => (env.RABBITMQ_DEFAULT_USER || env.RABBITMQ_DEFAULT_PASS
      ? { user: env.RABBITMQ_DEFAULT_USER || 'guest', password: env.RABBITMQ_DEFAULT_PASS || 'guest' }
      : undefined),
  },
  kafka: {
    ports: [9092],
    aliases: ['KAFKA'],
    fixedHostPort: true,
    adjust: (spec, { hostPort }) => adjustKafka(spec, hostPort ?? 9092),
  },
  redpanda: {
    ports: [9092],
    aliases: ['REDPANDA', 'KAFKA'],
    fixedHostPort: true,
    adjust: (spec, { hostPort }) => adjustRedpanda(spec, hostPort ?? 9092),
  },
  elasticsearch: {
    ports: [9200],
    aliases: ['ELASTICSEARCH', 'ELASTIC', 'ES'],
    plainHttp: true,
    adjust: ({ env }) => {
      env['discovery.type'] ||= 'single-node';
      env['xpack.security.enabled'] = 'false';
      env['xpack.security.http.ssl.enabled'] = 'false';
      env.ES_JAVA_OPTS ||= JAVA_HEAP;
    },
  },
  opensearch: {
    ports: [9200],
    aliases: ['OPENSEARCH', 'ELASTICSEARCH', 'ES'],
    plainHttp: true,
    adjust: ({ env }) => {
      env['discovery.type'] ||= 'single-node';
      env.DISABLE_SECURITY_PLUGIN = 'true';
      env.DISABLE_INSTALL_DEMO_CONFIG = 'true';
      env.OPENSEARCH_JAVA_OPTS ||= JAVA_HEAP;
    },
  },
  meilisearch: {
    ports: [7700],
    aliases: ['MEILI', 'MEILISEARCH'],
    adjust: ({ env }, { secret }) => {
      env.MEILI_MASTER_KEY ||= secret();
    },
    credentials: (env) => ({ user: '', password: env.MEILI_MASTER_KEY ?? '' }),
  },
  typesense: {
    ports: [8108],
    aliases: ['TYPESENSE'],
    adjust: (spec, { secret }) => {
      const command = spec.command ?? [];
      const fromCommand = command.map((arg, i) => (arg.startsWith('--api-key=') ? arg.slice(10) : arg === '--api-key' ? command[i + 1] : undefined)).find(Boolean);
      spec.env.TYPESENSE_API_KEY ||= fromCommand || secret();
      if (!spec.env.TYPESENSE_DATA_DIR && !command.some((arg) => arg.startsWith('--data-dir'))) spec.env.TYPESENSE_DATA_DIR = '/tmp';
    },
    credentials: (env) => ({ user: '', password: env.TYPESENSE_API_KEY ?? '' }),
  },
};

export const adapterOf = (kind: ComposeKind): Adapter => ADAPTERS[kind];

export interface ContainerSpec {
  env: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  /** Each container port, on a random host port on 127.0.0.1, or on `host` when it must be known first */
  publish: ComposePort[];
}

/** What the container is started with: compose's safe settings, adjusted for its kind. Pure. */
export function containerSpec(service: ComposeService, context: { hostPort?: number; secret: () => string }): ContainerSpec {
  const adapter = ADAPTERS[service.kind];
  const spec: { env: Record<string, string>; command?: string[]; image: string } = {
    env: { ...service.env },
    ...(service.command ? { command: [...service.command] } : {}),
    image: service.image,
  };
  adapter.adjust?.(spec, context);
  const containerPorts = service.ports.length ? service.ports.map((p) => p.container) : adapter.ports;
  const publish = adapter.fixedHostPort && context.hostPort
    ? [{ container: context.hostPort, host: context.hostPort }]
    : containerPorts.map((container) => ({ container }));
  return {
    env: spec.env,
    ...(spec.command ? { command: spec.command } : {}),
    ...(service.entrypoint ? { entrypoint: service.entrypoint } : {}),
    publish,
  };
}

/** The `docker run` arguments: a label, the run's own network, the env and local ports, nothing else */
export function composeRunArgs(service: ComposeService, spec: ContainerSpec, options: { labels: string[]; network: string }): string[] {
  const [entry, ...entryArgs] = spec.entrypoint ?? [];
  return [
    'run', '-d', '--rm',
    ...options.labels.flatMap((label) => ['--label', label]),
    '--network', options.network, '--network-alias', service.name,
    ...Object.entries(spec.env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    ...spec.publish.flatMap((p) => ['-p', p.host ? `127.0.0.1:${p.host}:${p.container}` : `127.0.0.1::${p.container}`]),
    ...(entry ? ['--entrypoint', entry] : []),
    service.image,
    ...entryArgs,
    ...(spec.command ?? []),
  ];
}

/** Values of a started service that must not reach a log: its passwords and keys */
export function composeSecrets(started: StartedComposeService[]): string[] {
  return started.flatMap((service) => {
    const credentials = ADAPTERS[service.kind].credentials?.(service.env, service.image);
    return credentials?.password ? [credentials.password] : [];
  });
}
