import { describe, expect, it } from 'vitest';

import { parseRecipe } from '../recipe';

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
