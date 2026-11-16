/**
 * One request through the running page, to a path its dev server proxies, to tell whether
 * the backend behind it answers. Local addresses only; no redirects followed, nothing kept
 * from the body. No Electron imports.
 */

import { request } from 'node:http';

export type ProbeResult = { status: number; error?: undefined } | { error: string; status?: undefined };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROBE_TIMEOUT_MS = 10_000;

export function probeThroughPage(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ error: 'BAD_URL' });
  }
  if (parsed.protocol !== 'http:' || !LOCAL_HOSTS.has(parsed.hostname)) return Promise.resolve({ error: 'NOT_LOCAL' });
  return new Promise((resolve) => {
    const req = request(parsed, { method: 'GET', headers: { accept: 'application/json, */*' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.once('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? 'ERROR' }));
    req.end();
  });
}
