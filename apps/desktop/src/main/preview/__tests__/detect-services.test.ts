import { describe, expect, it } from 'vitest';

import { proposeDesktop, proposePreviewServices, workspaceLibraries } from '../detect-services';

function project(files: Record<string, string>) {
  return { files: Object.keys(files), read: (path: string) => files[path] ?? null };
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

const electron = (scripts: Record<string, string>, deps: Record<string, string> = { electron: '^33.0.0' }) => JSON.stringify({ scripts, devDependencies: deps });

describe('proposeDesktop', () => {
  it('proposes an Electron app by its dev script, else its start script, in its own folder, with the lockfile\'s manager', () => {
    expect(proposeDesktop(project({ 'package.json': electron({ dev: 'electron .' }), 'pnpm-lock.yaml': '' }))).toEqual({
      version: 1, kind: 'desktop', services: [{ name: 'app', dir: '', command: 'pnpm run dev', page: true }],
    });
    expect(proposeDesktop(project({ 'apps/shell/package.json': electron({ start: 'electron-forge start' }) }))?.services).toEqual([{ name: 'app', dir: 'apps/shell', command: 'npm run start', page: true }]);
  });

  it('proposes Electron with a Vite renderer as a desktop app (electron-vite, vite-plugin-electron)', () => {
    expect(proposeDesktop(project({ 'package.json': electron({ dev: 'electron-vite dev' }, { electron: '1', 'electron-vite': '2' }) }))?.kind).toBe('desktop');
    expect(proposeDesktop(project({ 'package.json': electron({ dev: 'vite' }, { electron: '1', 'vite-plugin-electron': '0.28' }) }))?.services?.[0].command).toBe('npm run dev');
  });

  it('leaves a web project that only has Electron among its dependencies to the web proposal', () => {
    expect(proposeDesktop(project({ 'package.json': electron({ dev: 'vite' }) }))).toBeNull();
    expect(proposeDesktop(project({ 'package.json': electron({ build: 'electron-builder' }) }))).toBeNull();
  });

  it('proposes Tauri by its config: the tauri script of the folder above, else cargo', () => {
    expect(proposeDesktop(project({ 'src-tauri/tauri.conf.json': '{}', 'package.json': pkg({ tauri: 'tauri', dev: 'vite' }), 'yarn.lock': '' }))?.services).toEqual([{ name: 'app', dir: '', command: 'yarn run tauri dev', page: true }]);
    expect(proposeDesktop(project({ 'desktop/src-tauri/Tauri.toml': '' }))?.services).toEqual([{ name: 'app', dir: 'desktop', command: 'cargo tauri dev', page: true }]);
  });

  it('proposes Flutter only when the app has a folder for this computer', () => {
    const files = { 'pubspec.yaml': 'name: notes\n', 'macos/Runner.xcodeproj/project.pbxproj': '' };
    expect(proposeDesktop(project(files), 'darwin')?.services).toEqual([{ name: 'app', dir: '', command: 'flutter run -d macos', page: true }]);
    expect(proposeDesktop(project(files), 'win32')).toBeNull();
    expect(proposeDesktop(project({ 'pubspec.yaml': '', 'windows/runner/main.cpp': '' }), 'win32')?.services?.[0].command).toBe('flutter run -d windows');
  });

  it('proposes a .NET desktop project (WinExe or MAUI) by its project file, and never a name that is not plain', () => {
    expect(proposeDesktop(project({ 'src/Notes/Notes.csproj': '<Project><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>' }))?.services).toEqual([
      { name: 'app', dir: 'src/Notes', command: 'dotnet run --project Notes.csproj', page: true },
    ]);
    expect(proposeDesktop(project({ 'App.csproj': '<Project><PropertyGroup><UseMaui>true</UseMaui></PropertyGroup></Project>' }))?.services?.[0].command).toBe('dotnet run --project App.csproj');
    expect(proposeDesktop(project({ 'Api.csproj': '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>' }))).toBeNull();
    expect(proposeDesktop(project({ 'x;rm -rf ~.csproj': '<OutputType>WinExe</OutputType>' }))).toBeNull();
  });
});

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


describe('proposePreviewServices beyond JavaScript', () => {
  const project = (files: Record<string, string>) => ({ files: Object.keys(files), read: (p: string) => files[p] ?? null });

  it('proposes a Django backend next to a Next frontend, keeping the frontend as the page', () => {
    const services = proposePreviewServices(
      project({
        'pnpm-lock.yaml': '',
        'web/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
        'backend/manage.py': '',
        'backend/requirements.txt': 'django',
      }),
    );
    expect(services).toEqual([
      { name: 'web', dir: 'web', command: 'pnpm run dev --port {port}', page: true },
      { name: 'backend', dir: 'backend', command: '.venv/bin/python manage.py runserver 127.0.0.1:{port}' },
    ]);
  });

  it('makes a Rails app the page when there is no JavaScript frontend', () => {
    expect(proposePreviewServices(project({ Gemfile: "gem 'rails'", 'bin/rails': '' }))).toEqual([
      { name: 'web', dir: '', command: 'bin/rails server -b 127.0.0.1 -p {port}', page: true },
    ]);
  });

  it('keeps names unique', () => {
    const names = proposePreviewServices(
      project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'manage.py': '', 'requirements.txt': 'django' }),
    ).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
