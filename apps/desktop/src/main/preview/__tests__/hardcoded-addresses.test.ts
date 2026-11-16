import { describe, expect, it } from 'vitest';

import type { PreviewService } from '../../../shared/types/project';
import { findHardcodedAddresses, proxiedPaths } from '../hardcoded-addresses';

const services: PreviewService[] = [
  { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true },
  { name: 'api', dir: 'apps/api', command: 'pnpm run dev' },
];

const project = (files: Record<string, string>) => ({ files: Object.keys(files), read: (path: string) => files[path] ?? null });

const VITE = 'import { defineConfig } from "vite";\n\nconst apiTarget = "http://localhost:3000";\n\nexport default defineConfig({\n  server: {\n    port: 5173,\n    proxy: {\n      "/api": apiTarget,\n      \'/health\': { target: apiTarget },\n    },\n  },\n});\n';

describe('findHardcodedAddresses: a config that sends to a service where the preview does not run it', () => {
  it("finds the planner-mhp proxy target, with its file and line", () => {
    const issues = findHardcodedAddresses(services, project({ 'apps/web/vite.config.ts': VITE }), { api: { ownPort: 3000, previewPort: 55819 } });
    expect(issues).toEqual([{ service: 'api', from: 'web', file: 'apps/web/vite.config.ts', line: 3, address: 'http://localhost:3000', ownPort: 3000, previewPort: 55819 }]);
  });

  it('finds nothing when every service runs on its own port', () => {
    expect(findHardcodedAddresses(services, project({ 'apps/web/vite.config.ts': VITE }), {})).toEqual([]);
  });

  it("ignores a service naming its own port, and comments", () => {
    const files = {
      'apps/web/vite.config.ts': '// the API is at http://localhost:3000 in development\nexport default { server: { port: 5173 } }\n',
      'apps/api/package.json': '{ "scripts": { "dev": "node x" } }',
    };
    expect(findHardcodedAddresses(services, project(files), { web: { ownPort: 5173, previewPort: 61000 }, api: { ownPort: 3000, previewPort: 61001 } })).toEqual([]);
  });

  it('reads the config files frameworks hard-code dev addresses in, and package.json only for its proxy field', () => {
    const files = {
      'apps/web/next.config.mjs': "export default { async rewrites() { return [{ source: '/api/:path*', destination: 'http://127.0.0.1:8000/api/:path*' }] } }\n",
      'apps/web/src/proxy.conf.json': '{\n  "/api": { "target": "http://localhost:8000" }\n}\n',
      'apps/web/webpack.dev.config.js': "module.exports = { devServer: { proxy: { '/api': 'http://[::1]:8000' } } }\n",
      'apps/web/package.json': '{\n  "name": "web",\n  "homepage": "http://localhost:8000/docs",\n  "proxy": "http://localhost:8000"\n}\n',
      'apps/web/src/api.ts': "fetch('http://localhost:8000/api')\n",
      'apps/web/vite.config.ts.bak': "'http://localhost:8000'\n",
    };
    const issues = findHardcodedAddresses(services, project(files), { api: { ownPort: 8000, previewPort: 61001 } });
    expect(issues.map((i) => `${i.file}:${i.line} ${i.address}`).sort()).toEqual([
      'apps/web/next.config.mjs:1 http://127.0.0.1:8000',
      'apps/web/package.json:4 http://localhost:8000',
      'apps/web/src/proxy.conf.json:2 http://localhost:8000',
      'apps/web/webpack.dev.config.js:1 http://[::1]:8000',
    ]);
  });

  it('scans every service, at the root too', () => {
    const root: PreviewService[] = [
      { name: 'web', dir: '', command: 'npm run dev', page: true },
      { name: 'api', dir: 'server', command: 'npm run dev' },
    ];
    const issues = findHardcodedAddresses(root, project({ 'vite.config.js': "export default { server: { proxy: { '/api': 'localhost:4000' } } }\n" }), { api: { ownPort: 4000, previewPort: 61001 } });
    expect(issues).toEqual([{ service: 'api', from: 'web', file: 'vite.config.js', line: 1, address: 'localhost:4000', ownPort: 4000, previewPort: 61001 }]);
  });
});

describe("proxiedPaths: what the page's dev server sends on to a backend", () => {
  it('takes the proxy keys and rewrite sources of the page service, else /api', () => {
    const page = services[0];
    expect(proxiedPaths(page, project({ 'apps/web/vite.config.ts': VITE }))).toEqual(['/api', '/health']);
    expect(proxiedPaths(page, project({ 'apps/web/next.config.js': "rewrites: () => [{ source: '/backend/:path*', destination: process.env.API }]" }))).toEqual(['/backend']);
    expect(proxiedPaths(page, project({ 'apps/web/vite.config.ts': "proxy: { '^/rpc/.*': { target } }" }))).toEqual(['/rpc']);
    expect(proxiedPaths(page, project({ 'apps/web/vite.config.ts': 'export default {}' }))).toEqual(['/api']);
  });
});
