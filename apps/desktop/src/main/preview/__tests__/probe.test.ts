import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { probeThroughPage } from '../probe';

let server: Server | null = null;

function serve(status: number): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/plain' }).end(req.url);
    });
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())).then(() => { server = null; }));

describe('probeThroughPage: one GET through the running page', () => {
  it('returns the status', async () => {
    const port = await serve(502);
    expect(await probeThroughPage(`http://127.0.0.1:${port}/api`)).toEqual({ status: 502 });
  });

  it('returns the error code when nothing listens', async () => {
    const port = await serve(200);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect(await probeThroughPage(`http://127.0.0.1:${port}/api`)).toEqual({ error: 'ECONNREFUSED' });
  });

  it('only ever asks a local address', async () => {
    expect(await probeThroughPage('http://example.com/api')).toEqual({ error: 'NOT_LOCAL' });
  });
});
