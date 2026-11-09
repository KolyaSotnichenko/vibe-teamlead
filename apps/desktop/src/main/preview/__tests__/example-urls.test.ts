import { describe, expect, it } from 'vitest';

import { examplePort, rewriteExampleUrls } from '../example-urls';

const read = (files: Record<string, string>) => (path: string) => files[path] ?? null;

describe('examplePort: where a service listens when run as its example says', () => {
  it("takes its port variable from its own .env.example", () => {
    const files = { 'apps/api/.env.example': 'PORT=3001\nX=1\n', 'apps/api/package.json': JSON.stringify({ scripts: { 'start:dev': 'nest start --watch' } }) };
    expect(examplePort({ name: 'api', dir: 'apps/api', command: 'pnpm run start:dev' }, read(files))).toBe(3001);
    expect(examplePort({ name: 'api', dir: 'apps/api', command: 'x', portEnv: 'API_PORT' }, read({ 'apps/api/.env.example': 'API_PORT="4000"' }))).toBe(4000);
  });

  it('takes a port its dev script names, then its framework default', () => {
    expect(examplePort({ name: 'web', dir: 'web', command: 'x' }, read({ 'web/package.json': JSON.stringify({ scripts: { dev: 'next dev -p 3100' } }) }))).toBe(3100);
    expect(examplePort({ name: 'web', dir: 'web', command: 'x' }, read({ 'web/package.json': JSON.stringify({ scripts: { dev: 'vite --port=5200' } }) }))).toBe(5200);
    expect(examplePort({ name: 'web', dir: 'apps/web', command: 'x' }, read({ 'apps/web/package.json': JSON.stringify({ scripts: { dev: 'next dev --turbopack' } }) }))).toBe(3000);
    expect(examplePort({ name: 'web', dir: '', command: 'x' }, read({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) }))).toBe(5173);
    expect(examplePort({ name: 'web', dir: '', command: 'x' }, read({ 'package.json': JSON.stringify({ scripts: { dev: 'ng serve' } }) }))).toBe(4200);
  });

  it("takes a backend framework's default from its command", () => {
    const none = read({});
    expect(examplePort({ name: 'b', dir: 'b', command: '.venv/bin/python manage.py runserver 127.0.0.1:{port}' }, none)).toBe(8000);
    expect(examplePort({ name: 'b', dir: 'b', command: 'poetry run uvicorn app.main:app --reload --port {port}' }, none)).toBe(8000);
    expect(examplePort({ name: 'b', dir: 'b', command: 'uv run flask run --port {port}' }, none)).toBe(5000);
    expect(examplePort({ name: 'b', dir: 'b', command: 'bin/rails server -p {port}' }, none)).toBe(3000);
    expect(examplePort({ name: 'b', dir: 'b', command: 'php artisan serve --port={port}' }, none)).toBe(8000);
  });

  it('knows nothing when nothing says', () => {
    expect(examplePort({ name: 'api', dir: 'api', command: 'x' }, read({ 'api/package.json': JSON.stringify({ scripts: { dev: 'node server.js' } }) }))).toBeUndefined();
    expect(examplePort({ name: 'api', dir: 'api', command: 'x' }, read({ 'api/.env.example': 'PORT=abc' }))).toBeUndefined();
  });
});

describe('rewriteExampleUrls', () => {
  const byPort = new Map([[3001, 'http://localhost:61001'], [3000, 'http://localhost:61002']]);

  it("points a local address at the preview's own port for that service, keeping the path", () => {
    expect(
      rewriteExampleUrls(
        {
          NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001',
          WEB_ORIGIN: 'http://127.0.0.1:3000/',
          STORAGE_PUBLIC_BASE_URL: 'http://localhost:3001/api/v1/uploads',
          OTHER: 'http://localhost:9999',
          REMOTE: 'https://api.example.com:3001',
          PLAIN: '3001',
        },
        byPort,
      ),
    ).toEqual({
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:61001',
      WEB_ORIGIN: 'http://localhost:61002/',
      STORAGE_PUBLIC_BASE_URL: 'http://localhost:61001/api/v1/uploads',
      OTHER: 'http://localhost:9999',
      REMOTE: 'https://api.example.com:3001',
      PLAIN: '3001',
    });
  });
});
