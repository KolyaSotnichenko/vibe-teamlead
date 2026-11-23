/**
 * Starting a recipe's services, without a session: for the Preview (preview-session.ts) and for
 * the app check that starts the project before QA (ai/verification/starts-check.ts). Backends
 * first and the page last, each on the port the project expects when it is free, with every
 * service's address known to the others; a `ready` path is waited for. A service that does not
 * start, or does not get ready, ends it with its name and the end of its log; what started
 * before it is the caller's to stop (each name is handed over before its start). No Electron
 * imports.
 */

import { resolve } from 'node:path';

import type { PreviewEnvVar } from '../../shared/types/preview';
import type { PreviewService } from '../../shared/types/project';
import type { startDevServer } from '../ai/dev-servers/dev-servers';
import { say } from '../say';
import { examplePort, previewAddressesByExamplePort } from './example-urls';
import type { DisplacedPorts } from './hardcoded-addresses';
import { envOf, serviceEnvVars } from './preview-env';
import type { ProbeResult } from './probe';

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
const TAIL_CHARS = 2000;
const LOG_LINES = 30;

export interface StartServicesDeps {
  startServer: (options: Parameters<typeof startDevServer>[0]) => ReturnType<typeof startDevServer>;
  stopServer: (name: string) => Promise<boolean>;
  pickPort: () => Promise<number>;
  /** Whether nothing listens on this local port */
  portFree: (port: number) => Promise<boolean>;
  probe: (url: string) => Promise<ProbeResult>;
  readLog: (path: string) => string | null;
  readyTimeouts?: { timeoutMs: number; pollMs: number };
}

export interface StartServicesInput {
  services: PreviewService[];
  /** The folder the services' `dir` is relative to */
  root: string;
  /** Where the dev-server manager keeps its logs and its list */
  specDir: string;
  /** The service's server name, e.g. `preview-web`, `starts-web` */
  serverName: (service: PreviewService) => string;
  read: (path: string) => string | null;
  /** A folder's variables before the service's own (preview-env.ts baseEnvVars) */
  baseVars: (dir: string) => PreviewEnvVar[];
  /** The owner's values for one service, by service name */
  serviceOverrides?: Record<string, Record<string, string>>;
  timeoutMs: number;
  /** Throws when the start is to stop (between services, and after each wait) */
  check: () => void;
  /** A server's name, just before it starts: the caller stops it when anything goes wrong */
  onServer?: (name: string) => void;
  /** A service is up: its log and values, before the next one starts (the Logs panel shows it at once) */
  onStarted?: (service: PreviewService, started: { logPath: string; vars: PreviewEnvVar[] }) => void;
  /** A started server's process ended on its own */
  onExit?: (service: PreviewService, name: string, port: number) => void;
}

export interface StartedRecipeServices {
  /** The page's address */
  url: string;
  /** In start order: backends first, the page last */
  ordered: PreviewService[];
  ports: Record<string, number>;
  logs: Record<string, string>;
  /** What each service got, by service name */
  vars: Record<string, PreviewEnvVar[]>;
  /** The services that could not have the port the project expects */
  displaced: DisplacedPorts;
}

const tail = (text: string) => text.slice(-TAIL_CHARS);

function logEnd(deps: StartServicesDeps, logPath: string | undefined): string {
  const log = (logPath ? deps.readLog(logPath) : null) ?? '';
  return tail(log.split('\n').slice(-LOG_LINES).join('\n').trim());
}

/** A service's port: the one the project expects when nothing holds it, else a free one no other service has */
async function choosePort(deps: StartServicesDeps, expected: number | undefined, taken: number[]): Promise<number> {
  if (expected && !taken.includes(expected) && (await deps.portFree(expected))) return expected;
  let port = await deps.pickPort();
  while (taken.includes(port)) port = await deps.pickPort();
  return port;
}

/**
 * A service whose recipe names a `ready` path: its port accepting a connection is not enough
 * (a framework may listen long before it can answer), so the path is asked until it answers
 * below 500. One that never does, or that is gone, ends the start.
 */
async function waitUntilReady(input: StartServicesInput, deps: StartServicesDeps, service: string, url: string, path: string, logPath: string, port: number): Promise<void> {
  const { timeoutMs, pollMs } = deps.readyTimeouts ?? { timeoutMs: READY_TIMEOUT_MS, pollMs: READY_POLL_MS };
  const deadline = Date.now() + timeoutMs;
  let last = 'nothing';
  for (;;) {
    const result = await deps.probe(url);
    input.check();
    if (result.status !== undefined && result.status < 500) return;
    last = String(result.status ?? result.error ?? 'nothing');
    // Nothing answered and nothing listens any more: it is gone, and waiting won't bring it back
    if (result.status === undefined && (await deps.portFree(port))) {
      throw Object.assign(new Error(say('stoppedBeforeReady', `${service} stopped before it was ready`, { service })), { logTail: logEnd(deps, logPath), service });
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    input.check();
  }
  throw Object.assign(new Error(say('notReady', `${service} did not get ready: ${path} answered ${last}`, { service, path, answer: last })), { logTail: logEnd(deps, logPath), service });
}

export async function startRecipeServices(input: StartServicesInput, deps: StartServicesDeps): Promise<StartedRecipeServices> {
  const { services, read } = input;
  const ordered = [...services.filter((s) => !s.page), ...services.filter((s) => s.page)];
  // Every port first: a backend may need the page's URL (CORS), and the page starts last
  const ports: Record<string, number> = {};
  const urls: Record<string, string> = {};
  const expected: Record<string, number | undefined> = {};
  for (const service of ordered) {
    expected[service.name] = examplePort(service, read);
    const port = await choosePort(deps, expected[service.name], Object.values(ports));
    ports[service.name] = port;
    urls[service.name] = `http://localhost:${port}`;
  }
  // Local addresses in the examples point at each service's own port here; urlEnv still wins
  const byExamplePort = previewAddressesByExamplePort(ordered, urls, read);
  const logs: Record<string, string> = {};
  const vars: Record<string, PreviewEnvVar[]> = {};
  const displaced: DisplacedPorts = {};
  let url = '';
  for (const service of ordered) {
    input.check();
    const own = serviceEnvVars(input.baseVars(service.dir), {
      byExamplePort,
      urlEnv: service.urlEnv,
      urls,
      recipe: service.env,
      serviceOverrides: input.serviceOverrides?.[service.name],
      portEnv: service.portEnv ?? 'PORT',
      port: ports[service.name],
    });
    const name = input.serverName(service);
    input.onServer?.(name);
    let actualPort = ports[service.name];
    let started: Awaited<ReturnType<typeof startDevServer>>;
    try {
      started = await deps.startServer({
        name,
        command: service.command,
        cwd: resolve(input.root, service.dir),
        specDir: input.specDir,
        port: ports[service.name],
        portEnv: service.portEnv ?? 'PORT',
        env: envOf(own),
        timeoutMs: input.timeoutMs,
        onExit: () => input.onExit?.(service, name, actualPort),
      });
    } catch (error) {
      input.check();
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(say('serviceNotStarted', `${service.name} did not start`, { service: service.name })), { logTail: tail(message), service: service.name });
    }
    // A stop while it was starting found nothing to stop yet
    try {
      input.check();
    } catch (error) {
      await deps.stopServer(name);
      throw error;
    }
    if (service.ready) await waitUntilReady(input, deps, service.name, `${started.url}${service.ready}`, service.ready, started.logPath, started.port);
    actualPort = started.port;
    ports[service.name] = started.port;
    vars[service.name] = own.map((v) => (v.source === 'port' ? { ...v, value: String(started.port) } : v));
    urls[service.name] = started.url;
    logs[service.name] = started.logPath;
    input.onStarted?.(service, { logPath: started.logPath, vars: vars[service.name] });
    if (service.page) url = started.url;
    const wanted = expected[service.name];
    if (wanted && started.port !== wanted) displaced[service.name] = { ownPort: wanted, previewPort: started.port };
  }
  return { url, ordered, ports, logs, vars, displaced };
}
