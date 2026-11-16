/**
 * Whether a local port is free for a preview service, with Node's `net` only (macOS and
 * Windows alike, no shell). Free means nothing answers on 127.0.0.1 or ::1 and the port can
 * be bound on both: a dev server may listen on `[::1]` only (Vite), and on macOS binding
 * 127.0.0.1 can succeed while another process holds the port on every address, so a
 * connection is tried as well. A machine without IPv6 counts as free there.
 */

import { createConnection, createServer } from 'node:net';

const IPV6_MISSING = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL']);

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(host === '::1' && IPV6_MISSING.has(error.code ?? '')));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(500);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

export async function localPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const [v4, v6] = await Promise.all([answers(port, '127.0.0.1'), answers(port, '::1')]);
  if (v4 || v6) return false;
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::1'));
}
