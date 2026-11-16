import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { localPortFree } from '../preview-ports';

const open: Server[] = [];

function listen(host: string, port = 0): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      open.push(server);
      resolve((server.address() as { port: number }).port);
    });
  });
}

const close = () => Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))));

afterEach(close);

describe('localPortFree: nothing listens on the port, on 127.0.0.1 or ::1', () => {
  it('is free once nothing listens there', async () => {
    const port = await listen('127.0.0.1');
    await close();
    expect(await localPortFree(port!)).toBe(true);
  });

  it('is taken when something listens on 127.0.0.1', async () => {
    const port = await listen('127.0.0.1');
    expect(await localPortFree(port!)).toBe(false);
  });

  it('is taken when something listens on ::1 only, as Vite may', async () => {
    const port = await listen('::1');
    if (port === null) return; // no IPv6 on this machine
    expect(await localPortFree(port)).toBe(false);
  });

  it('is taken when something listens on every address', async () => {
    const port = await listen('0.0.0.0');
    expect(await localPortFree(port!)).toBe(false);
  });

  it('is never free outside 1..65535', async () => {
    expect(await localPortFree(0)).toBe(false);
    expect(await localPortFree(70000)).toBe(false);
  });
});
