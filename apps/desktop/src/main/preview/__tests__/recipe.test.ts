import { describe, expect, it } from 'vitest';

import type { PreviewService } from '../../../shared/types/project';
import { saidFor } from '../../say';
import { parseRecipe, resolveRecipe } from '../recipe';

const WEB = { version: 1, kind: 'web', services: [{ name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', port: 5173, page: true }] };
const parse = (value: unknown) => parseRecipe(JSON.stringify(value));
const reasonOf = (value: unknown) => {
  const result = parse(value);
  return result.ok ? '' : result.reason;
};

describe('parseRecipe', () => {
  it('reads a full recipe', () => {
    const full = {
      ...WEB,
      services: [
        { name: 'api', dir: 'apps/api', command: 'pnpm run dev', port: 3000, portEnv: 'PORT', ready: '/health', env: { AUTH_MODE: 'dev' } },
        { ...WEB.services[0], urlEnv: { VITE_API_URL: 'api' } },
      ],
      steps: {
        install: [{ dir: '', command: 'pnpm install' }],
        build: [],
        migrate: [{ dir: 'apps/api', command: 'pnpm exec prisma migrate deploy' }],
        seed: [{ dir: 'apps/api', command: 'pnpm run db:seed' }],
      },
      env: { FEATURE_X: 'on' },
    };
    expect(parse(full)).toEqual({ ok: true, recipe: full });
  });

  it('needs only version and kind', () => {
    expect(parse({ version: 1, kind: 'none' })).toEqual({ ok: true, recipe: { version: 1, kind: 'none' } });
  });

  it('refuses text that is not JSON, another version, an unknown kind and unknown keys', () => {
    expect(parseRecipe('{').ok).toBe(false);
    expect(reasonOf({ ...WEB, version: 2 })).toMatch(/version/);
    expect(reasonOf({ ...WEB, kind: 'game' })).toMatch(/kind/);
    expect(reasonOf({ ...WEB, volumes: ['/:/host'] })).toMatch(/volumes/);
  });

  it("wants exactly one page among a web recipe's services, and distinct plain names", () => {
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], page: undefined }] })).toMatch(/page/);
    expect(reasonOf({ ...WEB, services: [WEB.services[0], { ...WEB.services[0] }] })).toMatch(/page|name/);
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], name: 'my web' }] })).toMatch(/name/);
  });

  it('gives each reason with its key and values, so the interface can say it in its own language', () => {
    const keyOf = (value: unknown) => saidFor([reasonOf(value)]).map(({ key, params }) => ({ key, params }));
    expect(saidFor([(parseRecipe('{') as { reason: string }).reason])).toMatchObject([{ key: 'recipeNotJson' }]);
    expect(keyOf({ ...WEB, version: 2 })).toEqual([{ key: 'recipeShape', params: { at: 'version', problem: expect.any(String) } }]);
    expect(keyOf({ ...WEB, volumes: ['/:/host'] })).toEqual([{ key: 'recipeUnknownKeys', params: { at: 'preview.json', keys: 'volumes' } }]);
    expect(keyOf({ ...WEB, services: [{ ...WEB.services[0], page: undefined }] })).toEqual([{ key: 'recipeOnePage', params: undefined }]);
    expect(keyOf({ ...WEB, services: [{ ...WEB.services[0], dir: '../x' }] })).toEqual([{ key: 'recipeDir', params: { at: 'services[0]' } }]);
    expect(keyOf({ ...WEB, services: [{ ...WEB.services[0], command: 'sudo make serve' }] })).toEqual([{ key: 'recipeCommand', params: { at: 'services[0]', reason: expect.any(String) } }]);
    expect(keyOf({ ...WEB, env: { PATH: 'x' } })).toEqual([{ key: 'recipeVariable', params: { at: 'env.PATH' } }]);
    expect(keyOf({ ...WEB, services: [{ ...WEB.services[0], urlEnv: { API_URL: 'nobody' } }] })).toEqual([{ key: 'recipeUrlEnv', params: { at: 'services[0].urlEnv.API_URL', target: 'nobody' } }]);
  });

  it('says how the root is written when a folder is refused', () => {
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], dir: '.' }] })).toMatch(/"" for the root/);
  });

  it.each(['../x', '/etc', 'a/../../b', 'a\\..\\b', './a/..'])('refuses the folder %s', (dir) => {
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], dir }] })).toMatch(/dir/);
    expect(reasonOf({ ...WEB, steps: { build: [{ dir, command: 'pnpm run build' }] } })).toMatch(/dir/);
  });

  it('refuses a command the Bash denylist refuses, wherever it is', () => {
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], command: 'rm -rf / && pnpm dev' }] })).toMatch(/services\[0\]\.command/);
    expect(reasonOf({ ...WEB, steps: { seed: [{ dir: '', command: 'sudo make seed' }] } })).toMatch(/steps\.seed\[0\]\.command/);
  });

  it.each(['PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'git_ssh'])('refuses the variable %s', (name) => {
    expect(reasonOf({ ...WEB, env: { [name]: 'x' } })).toMatch(new RegExp(name));
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], env: { [name]: 'x' } }] })).toMatch(new RegExp(name));
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], portEnv: name }] })).toMatch(/portEnv|PATH|NODE|DYLD|git/i);
  });

  it('refuses ports outside 1–65535, a ready path without a slash, and a file over 64 KiB', () => {
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], port: 70000 }] })).toMatch(/port/);
    expect(reasonOf({ ...WEB, services: [{ ...WEB.services[0], ready: 'health' }] })).toMatch(/ready/);
    expect(parseRecipe(JSON.stringify({ ...WEB, env: { A: 'x'.repeat(70_000) } })).ok).toBe(false);
  });
});

describe('resolveRecipe', () => {
  const SAVED: PreviewService[] = [{ name: 'app', dir: '', command: 'npm run dev', page: true }];
  const VITE = { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) };
  const resolve = (files: Record<string, string>, saved: PreviewService[] = []) => resolveRecipe({ files: Object.keys(files), read: (p) => files[p] ?? null, saved });

  it('uses preview.json before the saved services', () => {
    expect(resolve({ 'preview.json': JSON.stringify(WEB) }, SAVED)).toEqual({ recipe: WEB, source: 'file', servicesFrom: 'file' });
  });

  it('uses the saved services when there is no file', () => {
    expect(resolve(VITE, SAVED)).toEqual({ recipe: { version: 1, kind: 'web', services: SAVED }, source: 'settings', servicesFrom: 'settings' });
  });

  it('uses the proposal without asking when it names exactly one page', () => {
    const r = resolve(VITE);
    expect(r.source).toBe('proposal');
    expect(r.recipe.services).toEqual([{ name: 'web', dir: '', command: 'npm run dev -- --port {port}', page: true }]);
  });

  it('has no source for a project nothing proposes a page for', () => {
    expect(resolve({ 'README.md': '' })).toEqual({ recipe: { version: 1, kind: 'web', services: [] }, source: 'none', servicesFrom: 'none' });
  });

  it('says why an unusable file was passed over, and goes on to the saved services', () => {
    const r = resolve({ 'preview.json': '{"version":2}' }, SAVED);
    expect(r.source).toBe('settings');
    expect(r.invalid).toMatch(/version/);
  });

  it('fills a file recipe without services from the saved ones, and keeps its steps', () => {
    const file = { version: 1, kind: 'web', steps: { seed: [] } };
    expect(resolve({ 'preview.json': JSON.stringify(file) }, SAVED)).toEqual({ recipe: { ...file, services: SAVED }, source: 'file', servicesFrom: 'settings' });
  });

  it('has no source for a file recipe without services when nothing else names them', () => {
    expect(resolve({ 'preview.json': '{"version":1,"kind":"web","env":{"A":"b"}}' })).toMatchObject({ source: 'none' });
  });

  it('asks instead of choosing when two frontends could be the page', () => {
    const two = { 'apps/admin/package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'apps/web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }) };
    expect(resolve(two)).toEqual({ recipe: { version: 1, kind: 'web', services: [] }, source: 'none', servicesFrom: 'none' });
  });

  it('does not ask for one frontend with a backend, or for a single service that is not a frontend', () => {
    const pair = { 'apps/api/package.json': JSON.stringify({ scripts: { dev: 'tsx watch src/index.ts' } }), 'apps/web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }) };
    expect(resolve(pair)).toMatchObject({ source: 'proposal', servicesFrom: 'proposal' });
    expect(resolve({ 'go.mod': 'module x', 'main.go': 'package main' })).toMatchObject({ source: 'proposal' });
  });

  it('says where the services came from, apart from where the recipe did', () => {
    expect(resolve({ 'preview.json': JSON.stringify(WEB) }, SAVED).servicesFrom).toBe('file');
    expect(resolve({ 'preview.json': '{"version":1,"kind":"web","steps":{"seed":[]}}' }, SAVED)).toMatchObject({ source: 'file', servicesFrom: 'settings' });
    expect(resolve(VITE, SAVED).servicesFrom).toBe('settings');
    expect(resolve(VITE).servicesFrom).toBe('proposal');
  });

  it('passes over a file whose folder is a link out of the project, and says so', () => {
    const files = { 'preview.json': JSON.stringify({ ...WEB, services: [{ ...WEB.services[0], dir: 'ext/app' }] }) };
    const r = resolveRecipe({ files: Object.keys(files), read: (p) => (files as Record<string, string>)[p] ?? null, saved: SAVED, contained: (dir) => dir !== 'ext/app' });
    expect(r.source).toBe('settings');
    expect(r.invalid).toMatch(/ext\/app.*out of the project/);
    expect(saidFor([r.invalid])).toMatchObject([{ key: 'recipeLink', params: { dir: 'ext/app' } }]);
  });

  it('leaves a recipe of another kind as it is', () => {
    expect(resolve({ 'preview.json': '{"version":1,"kind":"desktop"}' }, SAVED)).toEqual({ recipe: { version: 1, kind: 'desktop' }, source: 'file', servicesFrom: 'none' });
  });
});
