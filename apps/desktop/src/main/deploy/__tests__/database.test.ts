import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../../shared/types';
import type { DeployProjectSettings } from '../../../shared/types/deploy';
import { addDatabase, addIntegration, sweepStaleLinkDirs, type DatabaseDeps } from '../database';

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'db-test-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const TOKEN = 'tok_SECRET_123';
const TERMS = {
  status: 'action_required',
  reason: 'INTEGRATION_TERMS_ACCEPTANCE_REQUIRED',
  message: 'Accept marketplace terms ... token=abc',
  verification_uri: 'https://vercel.com/my-team/~/integrations/accept-terms/neon?source=cli',
  policy_links: {
    'Marketplace End User Addendum': 'https://vercel.com/legal/integration-marketplace-end-users-addendum',
    Evil: 'javascript:alert(1)',
    Http: 'http://example.com/x',
  },
};

/** Fake CLI: answers per scenario, one JSON-ish response per call, recording argv/cwd/env/link file. */
function fakeCli(responses: Record<string, Array<{ code: number; out: string; delay?: number }>>): { bin: string; calls: () => Array<any> } {
  const bin = path.join(work, 'fake-vercel');
  const log = path.join(work, 'calls.jsonl');
  const script = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const responses = ${JSON.stringify(responses)};
const sub = process.argv.slice(2).filter(a => !a.startsWith('-') ).slice(0, 2).join(' ');
const state = ${JSON.stringify(path.join(work, 'state.json'))};
let st = {}; try { st = JSON.parse(fs.readFileSync(state, 'utf8')); } catch {}
const i = st[sub] || 0; st[sub] = i + 1; fs.writeFileSync(state, JSON.stringify(st));
let link = null; try { link = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.vercel', 'project.json'), 'utf8')); } catch {}
let mode = null; try { mode = fs.statSync(process.cwd()).mode & 0o777; } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), token: process.env.VERCEL_TOKEN, link, mode }) + '\\n');
const list = responses[sub] || [{ code: 0, out: '{}' }];
const r = list[Math.min(i, list.length - 1)];
const done = () => { process.stdout.write(r.out); process.exit(r.code); };
if (r.delay) setTimeout(done, r.delay); else done();
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
  };
}

function setup(responses: Record<string, Array<{ code: number; out: string; delay?: number }>>, deploy?: Partial<DeployProjectSettings>, extra: Partial<DatabaseDeps> = {}) {
  const cli = fakeCli(responses);
  const saved: Array<Partial<DeployProjectSettings>> = [];
  let current: DeployProjectSettings = { enabled: true, vercel: { projectId: 'prj_1', projectName: 'my-cool-app', teamId: 'team_1' }, ...deploy } as DeployProjectSettings;
  const mk = () => ({ id: 'p1', name: 'My Cool App!', path: '/x/my-cool-app', settings: { deploy: structuredClone(current) } }) as unknown as Project;
  const tmpRoot = mkdtempSync(path.join(work, 'tmp-'));
  const deps: DatabaseDeps = {
    binary: cli.bin,
    configDir: path.join(work, 'config'),
    getToken: async () => TOKEN,
    saveSettings: (p) => {
      if (extra.saveSettings) return extra.saveSettings(p);
      saved.push(p);
      current = { ...current, ...p };
    },
    loadProject: () => mk(),
    userId: 'user_1',
    tmpRoot,
    now: () => new Date('2026-11-11T10:00:00Z'),
    ...extra,
  };
  if (extra.saveSettings) {
    const inner = extra.saveSettings;
    deps.saveSettings = (p) => {
      const r = inner(p);
      return r;
    };
  }
  const project = mk();
  return { cli, saved, deps, project, tmpRoot };
}

const OK = { code: 0, out: 'Installing...\n{"status":"ok"}\n' };
const NOT_INSTALLED = { code: 0, out: '{"installations":[]}' };
const INSTALLED = { code: 0, out: '{"installations":[{"integration":{"slug":"neon"}}]}' };

describe('addDatabase', () => {
  it('adds Neon in a private link dir and records it', async () => {
    const { cli, saved, deps, project, tmpRoot } = setup({ 'integration installations': [INSTALLED], 'integration add': [OK] });
    const r = await addDatabase(project, deps);
    expect(r).toEqual({ ok: true });
    expect(saved).toEqual([
      { pendingDatabase: { name: 'my-cool-app-db', at: '2026-11-11T10:00:00.000Z' } },
      { database: { provider: 'neon', addedAt: '2026-11-11T10:00:00.000Z' }, pendingDatabase: undefined },
    ]);
    const calls = cli.calls();
    const add = calls.find((c) => c.argv[0] === 'integration' && c.argv[1] === 'add')!;
    expect(add.argv).toEqual(expect.arrayContaining(['neon', '--billing-plan', 'free_v3', '--no-env-pull', '--json']));
    expect(add.argv.join(' ')).toContain('-e production -e preview');
    expect(add.argv[add.argv.indexOf('--name') + 1]).toBe('my-cool-app-db');
    expect(add.link).toEqual({ projectId: 'prj_1', orgId: 'team_1' });
    expect(add.mode).toBe(0o700);
    expect(add.argv).toEqual(expect.arrayContaining(['--global-config', path.join(work, 'config')]));
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('uses the user id as orgId for a personal project', async () => {
    const { cli, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [OK] }, { vercel: { projectId: 'prj_1', projectName: 'a' } });
    await addDatabase(project, deps);
    expect(cli.calls().find((c) => c.argv[1] === 'add')!.link.orgId).toBe('user_1');
  });

  it('terms needed: returns a needed item with validated links and does not accept', async () => {
    const { cli, saved, deps, project, tmpRoot } = setup({
      'integration installations': [NOT_INSTALLED],
      'integration add': [{ code: 1, out: `Vercel CLI 65\n${JSON.stringify(TERMS)}\n` }],
    });
    const r = await addDatabase(project, deps);
    expect(r.ok).toBe(false);
    const needed = (r as any).needed;
    expect(needed.kind).toBe('database-terms');
    expect(needed.integration).toBe('neon');
    expect(needed.policyLinks).toEqual([{ name: 'Marketplace End User Addendum', url: 'https://vercel.com/legal/integration-marketplace-end-users-addendum', host: 'vercel.com' }]);
    expect(JSON.stringify(needed)).not.toContain('token=abc');
    expect(cli.calls().some((c) => c.argv[1] === 'accept-terms')).toBe(false);
    expect(saved.some((p) => p.database)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('acceptTerms: runs accept-terms then add again', async () => {
    const { cli, saved, deps, project } = setup({
      'integration installations': [NOT_INSTALLED],
      'integration add': [{ code: 1, out: JSON.stringify(TERMS) }, OK],
      'integration accept-terms': [{ code: 0, out: '{"status":"ok"}' }],
    });
    const r = await addDatabase(project, deps, { acceptTerms: true });
    expect(r).toEqual({ ok: true });
    const subs = cli.calls().map((c) => c.argv.slice(0, 2).join(' '));
    expect(subs).toEqual(['integration installations', 'integration add', 'integration accept-terms', 'integration add']);
    const acc = cli.calls()[2];
    expect(acc.argv).toEqual(expect.arrayContaining(['neon', '--yes', '--json']));
    expect(saved.filter((p) => p.database)).toHaveLength(1);
  });

  it('already installed: terms are not asked for', async () => {
    const { cli, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [OK] });
    await addDatabase(project, deps, { acceptTerms: true });
    expect(cli.calls().some((c) => c.argv[1] === 'accept-terms')).toBe(false);
  });

  it('other action_required becomes database-dashboard with a vercel.com fallback only', async () => {
    const other = { status: 'action_required', reason: 'BILLING', verification_uri: 'https://vercel.com/t/~/billing' };
    const a = setup({ 'integration installations': [INSTALLED], 'integration add': [{ code: 1, out: JSON.stringify(other) }] });
    const r1: any = await addDatabase(a.project, a.deps);
    expect(r1.needed.kind).toBe('database-dashboard');
    expect(r1.needed.actionUrl).toBe('https://vercel.com/t/~/billing');
    const evil = { ...other, verification_uri: 'https://vercel.com.evil.io/x' };
    const b = setup({ 'integration installations': [INSTALLED], 'integration add': [{ code: 1, out: JSON.stringify(evil) }] });
    const r2: any = await addDatabase(b.project, b.deps);
    expect(r2.needed.kind).toBe('database-dashboard');
    expect(r2.needed.actionUrl).toBeUndefined();
  });

  it('plan fallback: picks the free plan from the listed ids once', async () => {
    const reject = { code: 1, out: 'Error: Billing plan not found: free_v3. Available plans: neon_free (Free), launch_v3 (Launch)\n' };
    const { cli, saved, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [reject, OK] });
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    const adds = cli.calls().filter((c) => c.argv[1] === 'add');
    expect(adds).toHaveLength(2);
    expect(adds[1].argv[adds[1].argv.indexOf('--billing-plan') + 1]).toBe('neon_free');
    expect(saved.filter((p) => p.database)).toHaveLength(1);
  });

  it('plan fallback happens once, then errors without echoing CLI output', async () => {
    const reject = { code: 1, out: 'Billing plan not found: x. Available plans: a_free (Free) https://x.io/?token=SECRET\n' };
    const { cli, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [reject] });
    const r: any = await addDatabase(project, deps);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cli');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(2);
  });

  it('already recorded: does nothing', async () => {
    const { cli, saved, deps, project } = setup({}, { database: { provider: 'neon', addedAt: 'x' } });
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    expect(cli.calls()).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('removes the link dir on failure and keeps the token out of argv and messages', async () => {
    const { cli, deps, project, tmpRoot } = setup({ 'integration installations': [INSTALLED], 'integration add': [{ code: 2, out: `boom ${TOKEN}` }] });
    const r = await addDatabase(project, deps);
    expect(r.ok).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    for (const c of cli.calls()) {
      expect(c.token).toBe(TOKEN);
      expect(JSON.stringify(c.argv)).not.toContain(TOKEN);
    }
  });

  it('errors when the project is not set up on Vercel or not signed in', async () => {
    const a = setup({}, { vercel: undefined });
    expect(((await addDatabase(a.project, a.deps)) as any).error.kind).toBe('not-set-up');
    const b = setup({}, undefined, { getToken: async () => null });
    expect(((await addDatabase(b.project, b.deps)) as any).error.kind).toBe('auth');
  });

  it('terms without readable links fall back to the dashboard', async () => {
    const noLinks = { ...TERMS, policy_links: { Evil: 'javascript:alert(1)' } };
    for (const body of [noLinks, { ...TERMS, policy_links: undefined }]) {
      const { deps, project } = setup({ 'integration installations': [NOT_INSTALLED], 'integration add': [{ code: 1, out: JSON.stringify(body) }] });
      const r: any = await addDatabase(project, deps);
      expect(r.needed.kind).toBe('database-dashboard');
      expect(r.needed.actionUrl).toBe(TERMS.verification_uri);
    }
  });

  it('save failing after a successful add is a distinct error, and a retry does not add again', async () => {
    let failDb = true;
    const { cli, deps, project } = setup(
      { 'integration installations': [INSTALLED], 'integration add': [OK], 'integration list': [{ code: 0, out: '{"resources":[{"name":"my-cool-app-db"}]}' }] },
      undefined,
      {
        saveSettings: (p) => {
          if (p.database && failDb) throw new Error('disk');
          lastSaved.push(p);
          return undefined;
        },
      },
    );
    const lastSaved: Array<Partial<DeployProjectSettings>> = [];
    const r: any = await addDatabase(project, deps);
    expect(r.error.kind).toBe('saved-failed');
    expect(r.error.message).toBe("The database was added, but the app couldn't save that");
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    // retry: the pending record (kept by the fake store) makes it look for the resource
    failDb = false;
    const retryDeps = { ...deps, loadProject: () => ({ ...project, settings: { deploy: { ...project.settings.deploy, pendingDatabase: lastSaved[0]?.pendingDatabase ?? { name: 'my-cool-app-db', at: 'x' } } } }) as Project };
    expect(await addDatabase(project, retryDeps)).toEqual({ ok: true });
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    expect(lastSaved.some((p) => p.database)).toBe(true);
  });

  it('timeout mid-add: the retry finds the existing resource', async () => {
    const { cli, saved, deps, project } = setup(
      {
        'integration installations': [INSTALLED],
        'integration add': [{ code: 0, out: '{}', delay: 6000 }],
        'integration list': [{ code: 0, out: '{"resources":[{"name":"my-cool-app-db"}]}' }],
      },
      undefined,
      { timeoutMs: 1500 },
    );
    const r1: any = await addDatabase(project, deps);
    expect(r1.error.kind).toBe('timeout');
    expect(saved.some((p) => p.pendingDatabase)).toBe(true);
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    expect(saved.some((p) => p.database)).toBe(true);
  });

  it('"already exists" on add counts as success only when this project lists a resource with the name', async () => {
    const { cli, saved, deps, project } = setup({
      'integration installations': [INSTALLED],
      'integration add': [{ code: 1, out: 'Error: A resource named my-cool-app-db already exists' }],
      'integration list': [{ code: 0, out: '{"resources":[{"name":"my-cool-app-db"}]}' }],
    });
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    expect(saved.some((p) => p.database)).toBe(true);
    const list = cli.calls().find((c) => c.argv[1] === 'list');
    expect(list?.argv).toEqual(expect.arrayContaining(['integration', 'list', '--json']));
    // asked in the private link dir: the list is this project's
    expect(list?.link).toEqual({ projectId: 'prj_1', orgId: 'team_1' });
  });

  it('"already exists" with no such resource on this project is a conflict, nothing recorded', async () => {
    const { saved, deps, project } = setup({
      'integration installations': [INSTALLED],
      'integration add': [{ code: 1, out: 'Error: A resource named my-cool-app-db already exists' }],
      'integration list': [{ code: 0, out: '{"resources":[{"name":"someone-elses-db"}]}' }],
    });
    const r: any = await addDatabase(project, deps);
    expect(r).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(saved.some((p) => p.database)).toBe(false);
  });

  it('"already exists" and the list fails: a conflict, not success', async () => {
    const { saved, deps, project } = setup({
      'integration installations': [INSTALLED],
      'integration add': [{ code: 1, out: 'Error: A resource named my-cool-app-db already exists' }],
      'integration list': [{ code: 1, out: 'Error' }],
    });
    expect(await addDatabase(project, deps)).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(saved.some((p) => p.database)).toBe(false);
  });

  it('two concurrent calls run add once', async () => {
    const { cli, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [{ code: 0, out: '{}', delay: 300 }] });
    const [a, b] = await Promise.all([addDatabase(project, deps), addDatabase(project, deps)]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(1);
  });

  it('uses a fresh project (loadProject) for the already-recorded check', async () => {
    const { cli, deps, project } = setup({}, undefined, { loadProject: () => ({ ...project, settings: { deploy: { ...project.settings.deploy, database: { provider: 'neon', addedAt: 'x' } } } }) as Project });
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    expect(cli.calls()).toEqual([]);
  });

  it('accept-terms failing is a cli error, not another terms item', async () => {
    const { deps, project } = setup({
      'integration installations': [NOT_INSTALLED],
      'integration add': [{ code: 1, out: JSON.stringify(TERMS) }],
      'integration accept-terms': [{ code: 1, out: 'nope' }],
    });
    const r: any = await addDatabase(project, deps, { acceptTerms: true });
    expect(r.error.kind).toBe('cli');
  });

  it('terms demanded again after accept: no loop, dashboard fallback', async () => {
    const { cli, deps, project } = setup({
      'integration installations': [NOT_INSTALLED],
      'integration add': [{ code: 1, out: JSON.stringify(TERMS) }],
      'integration accept-terms': [{ code: 0, out: '{}' }],
    });
    const r: any = await addDatabase(project, deps, { acceptTerms: true });
    expect(r.needed.kind).toBe('database-dashboard');
    expect(cli.calls().filter((c) => c.argv[1] === 'accept-terms')).toHaveLength(1);
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(2);
  });

  it('already installed + terms demanded + acceptTerms: no accept call', async () => {
    const { cli, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [{ code: 1, out: JSON.stringify(TERMS) }] });
    const r: any = await addDatabase(project, deps, { acceptTerms: true });
    expect(r.needed.kind).toBe('database-terms');
    expect(cli.calls().some((c) => c.argv[1] === 'accept-terms')).toBe(false);
  });
});

const UPSTASH_INSTALLED = { code: 0, out: '{"installations":[{"integration":{"slug":"upstash"}}]}' };

describe('addIntegration', () => {
  it('redis: integration add upstash/upstash-kv with the -redis name, recorded under services', async () => {
    const { cli, saved, deps, project } = setup({ 'integration installations': [UPSTASH_INSTALLED], 'integration add': [OK] });
    expect(await addIntegration(project, deps, { integration: 'redis' })).toEqual({ ok: true });
    const add = cli.calls().find((c) => c.argv[0] === 'integration' && c.argv[1] === 'add')!;
    expect(add.argv.slice(0, 3)).toEqual(['integration', 'add', 'upstash/upstash-kv']);
    expect(add.argv[add.argv.indexOf('--name') + 1]).toBe('my-cool-app-redis');
    expect(add.argv).toEqual(expect.arrayContaining(['--billing-plan', 'free_v3', '--no-env-pull', '--json']));
    expect(add.argv.join(' ')).toContain('-e production -e preview');
    expect(saved).toEqual([
      { pendingServices: { redis: { name: 'my-cool-app-redis', at: '2026-11-11T10:00:00.000Z' } } },
      { services: { redis: { addedAt: '2026-11-11T10:00:00.000Z' } }, pendingServices: undefined },
    ]);
  });

  it('redis keeps the other recorded service when saving', async () => {
    const { saved, deps, project } = setup({ 'integration installations': [UPSTASH_INSTALLED], 'integration add': [OK] }, { services: { blob: { addedAt: 'b' } } });
    await addIntegration(project, deps, { integration: 'redis' });
    expect(saved[1]).toEqual({ services: { blob: { addedAt: 'b' }, redis: { addedAt: '2026-11-11T10:00:00.000Z' } }, pendingServices: undefined });
  });

  it('redis terms flow: database-terms with integration redis, then accept-terms upstash', async () => {
    const { cli, deps, project } = setup({
      'integration installations': [NOT_INSTALLED],
      'integration add': [{ code: 1, out: JSON.stringify(TERMS) }, { code: 1, out: JSON.stringify(TERMS) }, OK],
    });
    const r = await addIntegration(project, deps, { integration: 'redis' });
    expect((r as any).needed).toMatchObject({ kind: 'database-terms', integration: 'redis' });
    expect((r as any).needed.id).toBe('redis-terms');
    expect(cli.calls().some((c) => c.argv[1] === 'accept-terms')).toBe(false);
    const r2 = await addIntegration(project, deps, { integration: 'redis', acceptTerms: true });
    expect(r2).toEqual({ ok: true });
    const acc = cli.calls().find((c) => c.argv[1] === 'accept-terms')!;
    expect(acc.argv.slice(0, 3)).toEqual(['integration', 'accept-terms', 'upstash']);
  });

  it('neon needed ids stay database-terms / database-dashboard', async () => {
    const { deps, project } = setup({ 'integration installations': [NOT_INSTALLED], 'integration add': [{ code: 1, out: JSON.stringify(TERMS) }] });
    const r = await addDatabase(project, deps);
    expect((r as any).needed.id).toBe('database-terms');
  });

  it('two adds of the same service at once run one CLI', async () => {
    const { cli, deps, project } = setup({ 'integration installations': [UPSTASH_INSTALLED], 'integration add': [{ code: 0, out: '{}', delay: 300 }] });
    const [a, b] = await Promise.all([addIntegration(project, deps, { integration: 'redis' }), addIntegration(project, deps, { integration: 'redis' })]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(1);
  });

  it('already recorded: does nothing', async () => {
    const { cli, deps, project } = setup({}, { services: { redis: { addedAt: 'x' } } });
    expect(await addIntegration(project, deps, { integration: 'redis' })).toEqual({ ok: true });
    expect(cli.calls()).toEqual([]);
  });

  it('blob: blob create-store <name>-blob --access private --yes -e production -e preview, in the link dir', async () => {
    const { cli, saved, deps, project, tmpRoot } = setup({ 'blob create-store': [{ code: 0, out: 'Blob store created' }] });
    expect(await addIntegration(project, deps, { integration: 'blob' })).toEqual({ ok: true });
    const call = cli.calls().find((c) => c.argv[0] === 'blob')!;
    expect(call.argv.slice(0, 3)).toEqual(['blob', 'create-store', 'my-cool-app-blob']);
    expect(call.argv).toEqual(expect.arrayContaining(['--access', 'private', '--yes']));
    expect(call.argv.join(' ')).toContain('-e production -e preview');
    expect(call.link).toEqual({ projectId: 'prj_1', orgId: 'team_1' });
    expect(saved[1]).toEqual({ services: { blob: { addedAt: '2026-11-11T10:00:00.000Z' } }, pendingServices: undefined });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('blob failing: a cli error without echoing output', async () => {
    const { deps, project } = setup({ 'blob create-store': [{ code: 1, out: 'boom token=abc' }] });
    const r = await addIntegration(project, deps, { integration: 'blob' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('token=abc');
  });
});

describe('service wording and Blob terms', () => {
  it('Redis and Blob errors name the service, not a database', async () => {
    const redis = setup(
      { 'integration installations': [NOT_INSTALLED], 'integration add': [{ code: 1, out: 'Error: already exists' }], 'integration list': [{ code: 0, out: '{"resources":[]}' }] },
    );
    const r = await addIntegration(redis.project, redis.deps, { integration: 'redis' });
    expect(r.ok).toBe(false);
    const error = 'error' in r ? r.error : undefined;
    expect(error?.kind).toBe('conflict');
    expect(error?.message).not.toMatch(/database/i);
    expect(error?.message).toContain('Redis');
    const blob = setup({}, {}, { saveSettings: () => { throw new Error('disk'); } });
    const b = await addIntegration(blob.project, blob.deps, { integration: 'blob' });
    expect('error' in b ? b.error.message : undefined).toBe('Adding the Blob store failed.');
  });

  it('Blob asking for terms with acceptTerms: the dashboard, no accept-terms call', async () => {
    const { cli, deps, project } = setup({ 'blob create-store': [{ code: 0, out: JSON.stringify(TERMS) }] });
    const r = await addIntegration(project, deps, { integration: 'blob', acceptTerms: true });
    expect(r).toMatchObject({ ok: false, needed: { kind: 'database-dashboard', integration: 'blob' } });
    expect(cli.calls().some((c) => c.argv.includes('accept-terms'))).toBe(false);
  });
});

describe('sweepStaleLinkDirs', () => {
  it('removes vt-db-* folders older than 10 minutes, keeps young ones and anything else', async () => {
    const root = mkdtempSync(path.join(work, 'sweep-'));
    const old = path.join(root, 'vt-db-old');
    const young = path.join(root, 'vt-db-young');
    const other = path.join(root, 'other-old');
    for (const d of [old, young, other]) mkdirSync(path.join(d, '.vercel'), { recursive: true });
    const now = Date.parse('2026-11-11T10:00:00Z');
    const past = new Date(now - 11 * 60_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    const recent = new Date(now - 60_000);
    utimesSync(young, recent, recent);
    await sweepStaleLinkDirs(root, now);
    expect(readdirSync(root).sort()).toEqual(['other-old', 'vt-db-young']);
  });

  it('runs at the start of each add', async () => {
    const { deps, project, tmpRoot } = setup({ 'blob create-store': [{ code: 0, out: 'ok' }] });
    const stale = path.join(tmpRoot, 'vt-db-stale');
    mkdirSync(stale);
    const past = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, past, past);
    await addIntegration(project, deps, { integration: 'blob' });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('never follows or removes a symlink named vt-db-*', async () => {
    const root = mkdtempSync(path.join(work, 'sweep-'));
    const elsewhere = mkdtempSync(path.join(work, 'elsewhere-'));
    writeFileSync(path.join(elsewhere, 'keep.txt'), 'x');
    const link = path.join(root, 'vt-db-x');
    symlinkSync(elsewhere, link);
    const past = new Date(Date.now() - 60 * 60_000);
    lutimesSync(link, past, past);
    await sweepStaleLinkDirs(root, Date.now());
    expect(readdirSync(root)).toEqual(['vt-db-x']);
    expect(existsSync(path.join(elsewhere, 'keep.txt'))).toBe(true);
  });

  it('skips a folder of another user, or one others can write to', async () => {
    const root = mkdtempSync(path.join(work, 'sweep-'));
    const dir = path.join(root, 'vt-db-old');
    mkdirSync(dir, { mode: 0o700 });
    const past = new Date(Date.now() - 60 * 60_000);
    utimesSync(dir, past, past);
    const me = process.getuid?.() ?? 0;
    await sweepStaleLinkDirs(root, Date.now(), { uid: me + 1 });
    expect(readdirSync(root)).toEqual(['vt-db-old']);
    chmodSync(dir, 0o777);
    utimesSync(dir, past, past);
    await sweepStaleLinkDirs(root, Date.now(), { uid: me });
    expect(readdirSync(root)).toEqual(['vt-db-old']);
    chmodSync(dir, 0o700);
    utimesSync(dir, past, past);
    await sweepStaleLinkDirs(root, Date.now(), { uid: me });
    expect(readdirSync(root)).toEqual([]);
  });

  it('never throws for a missing root', async () => {
    await expect(sweepStaleLinkDirs(path.join(work, 'missing'))).resolves.toBeUndefined();
  });
});
