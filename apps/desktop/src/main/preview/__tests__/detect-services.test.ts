import { describe, expect, it } from 'vitest';

import { proposePreviewServices, workspaceLibraries } from '../detect-services';

function project(files: Record<string, string>) {
  return { files: Object.keys(files), read: (path: string) => files[path] ?? null };
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

describe('proposePreviewServices', () => {
  it('proposes the Next app of a pnpm monorepo as the page and the Nest app as a backend', () => {
    const services = proposePreviewServices(project({
      'pnpm-lock.yaml': '',
      'package.json': pkg({ test: 'vitest' }),
      'apps/web/package.json': pkg({ dev: 'next dev', build: 'next build' }),
      'apps/api/package.json': pkg({ 'start:dev': 'nest start --watch', build: 'nest build' }),
    }));
    expect(services).toEqual([
      { name: 'api', dir: 'apps/api', command: 'pnpm run start:dev' },
      { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true },
    ]);
  });

  it('marks a Vite root app as the page', () => {
    const services = proposePreviewServices(project({ 'package-lock.json': '', 'package.json': pkg({ dev: 'vite' }) }));
    expect(services).toEqual([{ name: 'web', dir: '', command: 'npm run dev -- --port {port}', page: true }]);
  });

  it('proposes nothing when no package has a dev or start:dev script', () => {
    expect(proposePreviewServices(project({ 'package.json': pkg({ build: 'tsc', test: 'vitest' }) }))).toEqual([]);
  });

  it('picks the first frontend as the page when there are two', () => {
    const services = proposePreviewServices(project({
      'yarn.lock': '',
      'apps/admin/package.json': pkg({ dev: 'vite' }),
      'apps/site/package.json': pkg({ dev: 'astro dev' }),
    }));
    expect(services.filter((s) => s.page).map((s) => s.name)).toEqual(['admin']);
    expect(services.map((s) => s.name)).toEqual(['admin', 'site']);
  });

  it('ignores packages inside node_modules and the app\'s own folders', () => {
    const services = proposePreviewServices(project({
      'package.json': pkg({ dev: 'vite' }),
      'node_modules/x/package.json': pkg({ dev: 'vite' }),
      '.vibe-teamlead/worktrees/tasks/001/package.json': pkg({ dev: 'vite' }),
    }));
    expect(services.map((s) => s.dir)).toEqual(['']);
  });

  it('skips a root dev script that only starts the workspace packages', () => {
    for (const dev of ['turbo run dev', 'pnpm -r --parallel dev', 'concurrently "pnpm:dev:*"', 'nx run-many -t serve']) {
      const services = proposePreviewServices(project({
        'pnpm-lock.yaml': '',
        'package.json': pkg({ dev }),
        'apps/web/package.json': pkg({ dev: 'next dev' }),
      }));
      expect(services.map((s) => s.dir)).toEqual(['apps/web']);
    }
  });
});

describe('workspaceLibraries', () => {
  const files = (extra: Record<string, string> = {}) => project({
    'pnpm-lock.yaml': '',
    'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', main: './dist/index.js', scripts: { build: 'tsc -p tsconfig.json' } }),
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', main: './src/index.ts', scripts: { build: 'tsup' } }),
    'packages/config/package.json': JSON.stringify({ name: '@acme/config', main: './dist/index.js' }),
    'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { '@acme/shared': 'workspace:*', '@acme/config': 'workspace:*', express: '^5' } }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@acme/ui': 'workspace:^', '@acme/shared': 'workspace:*' } }),
    ...extra,
  });
  const services = [{ name: 'api', dir: 'apps/api', command: 'x' }, { name: 'web', dir: 'apps/web', command: 'y', page: true }];

  it('builds the workspace packages the services use whose entry is built output', () => {
    expect(workspaceLibraries(files(), services)).toEqual([{ name: '@acme/shared', dir: 'packages/shared', command: 'pnpm run build' }]);
  });

  it('builds a package a library itself needs, before that library', () => {
    const f = files({
      'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', main: './dist/index.js', scripts: { build: 'tsc' }, dependencies: { '@acme/core': 'workspace:*' } }),
      'packages/core/package.json': JSON.stringify({ name: '@acme/core', exports: { '.': { types: './dist/index.d.ts' } }, scripts: { build: 'tsc' } }),
    });
    expect(workspaceLibraries(f, services).map((l) => l.name)).toEqual(['@acme/core', '@acme/shared']);
  });

  it('builds nothing for a single-package project', () => {
    expect(workspaceLibraries(project({ 'package.json': JSON.stringify({ name: 'app', scripts: { dev: 'vite' } }) }), [{ name: 'web', dir: '', command: 'x', page: true }])).toEqual([]);
  });
});

