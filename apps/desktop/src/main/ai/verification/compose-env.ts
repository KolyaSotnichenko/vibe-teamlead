/**
 * The example settings that point at a compose service, pointed at its throwaway container
 * instead. A setting points at a service when its host is the service's compose name, or
 * localhost with a port the service has (`amqp://guest:guest@rabbitmq:5672`,
 * `http://localhost:9000`, `kafka:9092`), or when a HOST/PORT pair's name names it
 * (`RABBITMQ_HOST=localhost`, `RABBITMQ_PORT=5672`). The host and port become the container's
 * on 127.0.0.1; scheme, path and the example's credentials stay, unless the container was
 * started with others. A few kinds also fill their settings by name (S3 keys, search keys).
 * What points at a service that didn't start is emptied, so nothing falls back to a real one.
 * Pure.
 */

import { adapterOf, type ComposeKind, type ComposePort, type ComposeService, type StartedComposeService } from './compose-services';

export interface ComposeWiring {
  /** The services compose names, started or not */
  planned: ComposeService[];
  started: StartedComposeService[];
}

export interface WiredValue {
  value: string;
  /** The compose service it comes from */
  service: string;
  started: boolean;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '[::1]']);
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, amqp: 5672, amqps: 5671, kafka: 9092, nats: 4222, mqtt: 1883 };
/** scheme://, credentials@, host, :port, then the rest */
const ADDRESS = /^([a-z][a-z0-9+.-]*:\/\/)?(?:([^@/\s]*)@)?([A-Za-z0-9_.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?([/?#].*)?$/;
/** Settings whose bare value may be a host name */
const HOST_LIKE = /_(HOST|HOSTNAME|HOSTS|SERVER|SERVERS|ENDPOINT|ADDR|ADDRESS|BROKER|BROKERS|NODE|NODES|URL|URI|DSN)$/;
const HOST_KEY = /^(.+)_(HOST|HOSTNAME)$/;
const PORT_KEY = /^(.+)_PORT$/;

function exampleValue(raw: string): string {
  return raw.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
}

/** The ports a service is published with: compose's, or its kind's own when compose names none */
function portsOf(service: ComposeService): ComposePort[] {
  return service.ports.length ? service.ports : adapterOf(service.kind).ports.map((container) => ({ container }));
}

/** Whether a setting's name (its part before _HOST, _PORT…) names the service */
function names(prefix: string, service: ComposeService): boolean {
  const upper = prefix.toUpperCase();
  const tokens = upper.split('_');
  const own = service.name.toUpperCase().replace(/[-.]/g, '_');
  return upper === own || upper.startsWith(`${own}_`) || upper.endsWith(`_${own}`) || adapterOf(service.kind).aliases.some((alias) => tokens.includes(alias));
}

function serviceAt(host: string, port: number | undefined, scheme: string | undefined, services: ComposeService[]): { service: ComposeService; container?: number } | undefined {
  const lower = host.toLowerCase();
  if (!LOCAL.has(lower)) {
    const service = services.find((s) => s.name.toLowerCase() === lower);
    if (!service) return undefined;
    const p = port ?? (scheme ? DEFAULT_PORTS[scheme] : undefined);
    return { service, container: portsOf(service).find((x) => x.container === p)?.container };
  }
  const p = port ?? (scheme ? DEFAULT_PORTS[scheme] : undefined);
  if (!p) return undefined;
  for (const service of services) {
    const published = portsOf(service).find((x) => x.host === p);
    if (published) return { service, container: published.container };
  }
  for (const service of services) {
    if (portsOf(service).some((x) => x.container === p && x.host === undefined)) return { service, container: p };
  }
  return undefined;
}

/** The host port of a container port, or the service's first */
function hostPort(started: StartedComposeService, container?: number): number | undefined {
  return (container !== undefined ? started.ports[container] : undefined) ?? Object.values(started.ports)[0];
}

const encode = (text: string) => encodeURIComponent(text);

function rewriteAddress(match: RegExpExecArray, service: ComposeService, started: StartedComposeService, container?: number): string {
  const [, schemePart = '', userinfo, , port, rest = ''] = match;
  const adapter = adapterOf(service.kind);
  const scheme = adapter.plainHttp && schemePart.toLowerCase() === 'https://' ? 'http://' : schemePart;
  const credentials = userinfo !== undefined && service.kind !== 's3' ? adapter.credentials?.(started.env, started.image) : undefined;
  const auth = credentials?.user ? `${encode(credentials.user)}:${encode(credentials.password)}@` : userinfo !== undefined ? `${userinfo}@` : '';
  const published = hostPort(started, container);
  const address = (schemePart || port !== undefined) && published ? `127.0.0.1:${published}` : '127.0.0.1';
  return `${scheme}${auth}${address}${rest}`;
}

type Found = { service: ComposeService; value: (started: StartedComposeService) => string };

/** A URL or host[:port] (or a list of them) pointing at a compose service */
function byAddress(name: string, value: string, services: ComposeService[]): Found | undefined {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) return undefined;
  const hits = items.map((item) => {
    const match = ADDRESS.exec(item);
    if (!match) return undefined;
    const scheme = match[1]?.slice(0, -3).toLowerCase();
    const port = match[4] !== undefined ? Number(match[4]) : undefined;
    // A bare word is a host only in a setting that names one, and only by the service's name
    if (!scheme && port === undefined && !HOST_LIKE.test(name)) return undefined;
    if (items.length > 1 && port === undefined) return undefined;
    const at = serviceAt(match[3], port, scheme, services);
    return at ? { ...at, match } : undefined;
  });
  const first = hits.find((hit) => hit !== undefined);
  if (!first) return undefined;
  const same = hits.filter((hit): hit is NonNullable<typeof hit> => hit?.service === first.service);
  return {
    service: first.service,
    value: (started) => [...new Set(same.map((hit) => rewriteAddress(hit.match, hit.service, started, hit.container)))].join(','),
  };
}

/** `NAME_HOST=localhost` and `NAME_PORT=5672` whose NAME names the service */
function byPair(name: string, value: string, services: ComposeService[]): Found | undefined {
  const host = HOST_KEY.exec(name);
  if (host && LOCAL.has(value.toLowerCase())) {
    const service = services.find((s) => names(host[1], s));
    if (service) return { service, value: () => '127.0.0.1' };
  }
  const port = PORT_KEY.exec(name);
  if (port && /^\d{1,5}$/.test(value)) {
    const service = services.find((s) => names(port[1], s));
    if (!service) return undefined;
    const ports = portsOf(service);
    const container = ports.find((p) => p.host === Number(value))?.container ?? ports.find((p) => p.container === Number(value))?.container;
    return { service, value: (started) => String(hostPort(started, container) ?? '') };
  }
  return undefined;
}

const S3_NAMESPACE = /(^|_)(S3|AWS|MINIO|STORAGE|R2|OBJECT_STORAGE|SPACES|BLOB|LOCALSTACK)(_|$)/;

/** Settings a kind fills by name, from what its container started with */
const SETTINGS: Partial<Record<ComposeKind, (name: string, value: string) => ((started: StartedComposeService) => string) | undefined>> = {
  s3: (name, value) => {
    if (!S3_NAMESPACE.test(name)) return undefined;
    const credentials = (started: StartedComposeService) => adapterOf('s3').credentials?.(started.env, started.image);
    // The secret first: SECRET_ACCESS_KEY also ends in ACCESS_KEY
    if (/(SECRET_ACCESS_KEY|SECRET_KEY)$/.test(name)) return (s) => credentials(s)?.password ?? '';
    if (/(ACCESS_KEY_ID|ACCESS_KEY)$/.test(name)) return (s) => credentials(s)?.user ?? '';
    if (/SESSION_TOKEN$/.test(name)) return () => '';
    if (/PATH_STYLE/.test(name)) return () => 'true';
    if (/(USE_SSL|_SSL)$/.test(name)) return () => 'false';
    if (/ENDPOINT(_URL)?$/.test(name)) return (s) => (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? `http://127.0.0.1:${hostPort(s) ?? ''}` : '127.0.0.1');
    return undefined;
  },
  rabbitmq: (name) => {
    if (/^(RABBITMQ|RABBIT|AMQP)_(USER|USERNAME|DEFAULT_USER|LOGIN)$/.test(name)) return (s) => adapterOf('rabbitmq').credentials?.(s.env, s.image)?.user ?? '';
    if (/^(RABBITMQ|RABBIT|AMQP)_(PASS|PASSWORD|DEFAULT_PASS)$/.test(name)) return (s) => adapterOf('rabbitmq').credentials?.(s.env, s.image)?.password ?? '';
    return undefined;
  },
  meilisearch: (name) => (/^(MEILI|MEILISEARCH)_(MASTER_KEY|KEY|API_KEY|ADMIN_KEY|ADMIN_API_KEY)$/.test(name) ? (s) => s.env.MEILI_MASTER_KEY ?? '' : undefined),
  typesense: (name) => (/^TYPESENSE_(API_KEY|ADMIN_API_KEY|KEY|ADMIN_KEY)$/.test(name) ? (s) => s.env.TYPESENSE_API_KEY ?? '' : undefined),
};

function byName(name: string, value: string, services: ComposeService[], wiring: ComposeWiring): Found | undefined {
  for (const service of services) {
    const setting = SETTINGS[service.kind]?.(name, value);
    if (!setting) continue;
    // RabbitMQ's users: only when the container was started with its own, otherwise the example's stay
    if (service.kind === 'rabbitmq') {
      const started = wiring.started.find((s) => s.name === service.name);
      if (started && !adapterOf('rabbitmq').credentials?.(started.env, started.image)) continue;
    }
    return { service, value: setting };
  }
  return undefined;
}

/** Each example setting that points at a compose service, with its value for the started container. Pure. */
export function composeEnv(example: string, wiring: ComposeWiring): Map<string, WiredValue> {
  const out = new Map<string, WiredValue>();
  if (!wiring.planned.length) return out;
  for (const line of example.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    const value = exampleValue(raw);
    const found = byAddress(name, value, wiring.planned) ?? byPair(name, value, wiring.planned) ?? byName(name, value, wiring.planned, wiring);
    if (!found) continue;
    const started = wiring.started.find((s) => s.name === found.service.name);
    out.set(name, { value: started ? found.value(started) : '', service: found.service.name, started: !!started });
  }
  return out;
}
