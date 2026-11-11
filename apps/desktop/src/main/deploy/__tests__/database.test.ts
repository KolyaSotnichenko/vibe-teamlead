import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../../shared/types';
import type { DeployProjectSettings } from '../../../shared/types/deploy';
import { addDatabase, type DatabaseDeps } from '../database';

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
        'integration add': [{ code: 0, out: '{}', delay: 5000 }],
        'integration list': [{ code: 0, out: '{"resources":[{"name":"my-cool-app-db"}]}' }],
      },
      undefined,
      { timeoutMs: 400 },
    );
    const r1: any = await addDatabase(project, deps);
    expect(r1.error.kind).toBe('timeout');
    expect(saved.some((p) => p.pendingDatabase)).toBe(true);
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    expect(cli.calls().filter((c) => c.argv[1] === 'add')).toHaveLength(1);
    expect(saved.some((p) => p.database)).toBe(true);
  });

  it('an "already exists" error on add counts as success', async () => {
    const { saved, deps, project } = setup({ 'integration installations': [INSTALLED], 'integration add': [{ code: 1, out: 'Error: A resource named x already exists' }] });
    expect(await addDatabase(project, deps)).toEqual({ ok: true });
    expect(saved.some((p) => p.database)).toBe(true);
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
