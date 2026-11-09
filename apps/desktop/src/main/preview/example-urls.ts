/**
 * The preview runs every service on a port of its own choosing, so the local addresses
 * in `.env.example` (`NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`) would point at
 * nothing, or at the owner's own dev servers. Each service's example port is worked out
 * from the project's files, and those addresses are pointed at the preview's ports, so
 * the owner sets no URL variables by hand. Pure: no Electron imports, no file access.
 */

import type { PreviewService } from '../../shared/types/project';

/** Where a frontend tool listens when its dev script names no port */
const FRAMEWORK_PORTS: Record<string, number> = {
  next: 3000,
  nuxt: 3000,
  nuxi: 3000,
  'react-scripts': 3000,
  remix: 3000,
  vite: 5173,
  'svelte-kit': 5173,
  'react-router': 5173,
  astro: 4321,
  ng: 4200,
};

const LOCAL_URL = /^(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/.*)?$/;

const asPort = (value: string | undefined): number | undefined => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
};

function exampleValue(text: string | null, key: string): string | undefined {
  for (const line of (text ?? '').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] === key) return match[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return undefined;
}

function devScript(text: string | null): string {
  try {
    const scripts = (JSON.parse(text ?? '') as { scripts?: Record<string, unknown> }).scripts ?? {};
    const script = scripts.dev ?? scripts['start:dev'];
    return typeof script === 'string' ? script : '';
  } catch {
    return '';
  }
}

/** The port the service listens on when run as the project describes it, if anything says. */
export function examplePort(service: PreviewService, read: (path: string) => string | null): number | undefined {
  const inDir = (file: string) => (service.dir ? `${service.dir}/${file}` : file);
  const fromExample = asPort(exampleValue(read(inDir('.env.example')), service.portEnv ?? 'PORT'));
  if (fromExample) return fromExample;
  const script = devScript(read(inDir('package.json')));
  const named = /(?:--port[=\s]|-p\s+|\bPORT=)(\d{2,5})\b/.exec(script)?.[1];
  if (asPort(named)) return asPort(named);
  return FRAMEWORK_PORTS[script.trim().split(/\s+/)[0] ?? ''];
}

/** The env with local addresses on a known example port pointed at that service's preview address. Pure. */
export function rewriteExampleUrls(env: Record<string, string>, byPort: Map<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = LOCAL_URL.exec(value);
    const target = match ? byPort.get(Number(match[2])) : undefined;
    out[key] = target ? `${target}${match?.[3] ?? ''}` : value;
  }
  return out;
}

/**
 * Example port → preview address for every service whose example port is known. A port two
 * services claim says nothing about either, so it is left out.
 */
export function previewAddressesByExamplePort(
  services: PreviewService[],
  urls: Record<string, string>,
  read: (path: string) => string | null,
): Map<number, string> {
  const claims = new Map<number, string[]>();
  for (const service of services) {
    const port = examplePort(service, read);
    if (port && urls[service.name]) claims.set(port, [...(claims.get(port) ?? []), urls[service.name]]);
  }
  return new Map([...claims].filter(([, owners]) => owners.length === 1).map(([port, owners]) => [port, owners[0]]));
}
