/**
 * Adds a Postgres database (Neon, through the Vercel Marketplace) to the project's Vercel
 * project with the Vercel CLI.
 *
 * `integration add` has no project option: it connects to "the current project", so each run
 * happens in a private temp directory holding `.vercel/project.json` (removed afterwards).
 * The Marketplace terms are never accepted silently: when Vercel asks for them the result is a
 * `database-terms` item for the UI, and `accept-terms` runs only when called again with
 * `acceptTerms: true` (the owner clicked Accept in the app). CLI output is parsed, never
 * copied into messages (it can carry URLs with codes or tokens).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Project } from '../../shared/types';
import type { DeployProjectSettings, NeededFromYou } from '../../shared/types/deploy';
import { runVercelCli, type RunVercelCliResult } from './vercel-cli';

export interface DatabaseDeps {
  /** The Vercel CLI binary (`ensureVercelCli`). */
  binary: string;
  configDir: string;
  getToken: () => Promise<string | null>;
  /** Merges `patch` into the stored `project.settings.deploy`. Throws when it can't save. */
  saveSettings: (patch: Partial<DeployProjectSettings>) => Promise<void> | void;
  /** The signed-in Vercel user's id: the org of a project in the personal account. */
  userId?: string;
  /** Parent of the private link directory (default: the OS temp dir). */
  tmpRoot?: string;
  now?: () => Date;
  timeoutMs?: number;
}

export type DatabaseErrorKind = 'not-set-up' | 'auth' | 'cli' | 'timeout' | 'unknown';

export type AddDatabaseResult =
  | { ok: true }
  | { ok: false; needed: NeededFromYou }
  | { ok: false; error: { kind: DatabaseErrorKind; message: string } };

const DEFAULT_PLAN = 'free_v3';
const DEFAULT_TIMEOUT_MS = 180_000;

const fail = (kind: DatabaseErrorKind, message: string): AddDatabaseResult => ({ ok: false, error: { kind, message } });

/** A JSON value from CLI output that may have progress lines before it. */
function parseCliJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[{[]/.test(lines[i])) {
      attempts.push(lines.slice(i).join('\n'));
      attempts.push(lines[i]);
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Does any slug/name-like field of the installations output say Neon? */
function mentionsNeon(v: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.some((x) => mentionsNeon(x, depth + 1));
  if (!isRecord(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && /^(slug|name|integration|integrationSlug|integrationId)$/i.test(k) && val.trim().toLowerCase() === 'neon') return true;
    if (mentionsNeon(val, depth + 1)) return true;
  }
  return false;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function vercelUrl(value: unknown): string | undefined {
  const url = httpsUrl(value);
  if (!url) return undefined;
  const host = new URL(url).hostname;
  return host === 'vercel.com' || host.endsWith('.vercel.com') ? url : undefined;
}

function policyLinks(raw: unknown): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  const add = (name: unknown, url: unknown) => {
    const ok = httpsUrl(url);
    if (ok) out.push({ name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : ok, url: ok });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') add(item, item);
      else if (isRecord(item)) add(item.name ?? item.title ?? item.label, item.url ?? item.href);
    }
  } else if (isRecord(raw)) {
    for (const [name, url] of Object.entries(raw)) add(name, url);
  }
  return out;
}

type Outcome =
  | { kind: 'ok' }
  | { kind: 'terms'; links: Array<{ name: string; url: string }> }
  | { kind: 'action'; url?: string }
  | { kind: 'plan-rejected'; plans: string[] }
  | { kind: 'failed' };

function plansFrom(text: string): string[] | null {
  const m = /Available plans?:\s*([^\n]+)/i.exec(text);
  if (!/plan[^\n]*not found/i.test(text) && !m) return null;
  if (!m) return [];
  return m[1]
    .split(',')
    .map((p) => /^\s*([A-Za-z0-9_-]+)/.exec(p)?.[1])
    .filter((p): p is string => !!p);
}

function classify(r: RunVercelCliResult): Outcome {
  const text = `${r.stdout}\n${r.stderr}`;
  const json = parseCliJson(r.stdout) ?? parseCliJson(r.stderr);
  if (isRecord(json) && json.status === 'action_required') {
    if (json.reason === 'INTEGRATION_TERMS_ACCEPTANCE_REQUIRED') return { kind: 'terms', links: policyLinks(json.policy_links ?? json.policyLinks) };
    return { kind: 'action', url: vercelUrl(json.verification_uri) };
  }
  if (r.code === 0) return { kind: 'ok' };
  const plans = plansFrom(text);
  if (plans) return { kind: 'plan-rejected', plans };
  return { kind: 'failed' };
}

/** Lowercase letters, digits and '-'; Neon/Vercel resource names are short. */
function databaseNameFor(project: Project): string {
  const base = (project.name || path.basename(project.path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${base || 'app'}-db`;
}

export async function addDatabase(project: Project, deps: DatabaseDeps, opts: { acceptTerms?: boolean } = {}): Promise<AddDatabaseResult> {
  const deploy = project.settings.deploy;
  if (deploy?.database) return { ok: true };
  const vercel = deploy?.vercel;
  if (!vercel?.projectId) return fail('not-set-up', 'This project is not set up on Vercel yet.');
  const orgId = vercel.teamId ?? deps.userId;
  if (!orgId) return fail('not-set-up', 'The Vercel account is not known yet.');
  const token = await deps.getToken();
  if (!token) return fail('auth', 'Sign in to Vercel first.');

  const root = deps.tmpRoot ?? tmpdir();
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(root, 'vt-db-'));
    await mkdir(path.join(dir, '.vercel'), { mode: 0o700 });
    await writeFile(path.join(dir, '.vercel', 'project.json'), JSON.stringify({ projectId: vercel.projectId, orgId }), { mode: 0o600 });

    const scope = vercel.teamId ? ['--scope', vercel.teamId] : [];
    const run = (args: string[]) =>
      runVercelCli([...args, ...scope], { binary: deps.binary, configDir: deps.configDir, token, cwd: dir, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    const dbName = databaseNameFor(project);
    const addArgs = (plan: string) => ['integration', 'add', 'neon', '--name', dbName, '--billing-plan', plan, '-e', 'production', '-e', 'preview', '--no-env-pull', '--json'];

    // Neon already installed on the team: the terms were accepted before.
    const inst = await run(['integration', 'installations', '--json']);
    const installed = inst.code === 0 && mentionsNeon(parseCliJson(inst.stdout));

    let plan = DEFAULT_PLAN;
    let planRetried = false;
    let accepted = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = classify(await run(addArgs(plan)));
      if (out.kind === 'ok') {
        await deps.saveSettings({ database: { provider: 'neon', addedAt: (deps.now?.() ?? new Date()).toISOString() } });
        return { ok: true };
      }
      if (out.kind === 'terms') {
        if (opts.acceptTerms && !accepted && !installed) {
          accepted = true;
          const acc = classify(await run(['integration', 'accept-terms', 'neon', '--yes', '--json']));
          if (acc.kind === 'ok') continue;
        }
        return { ok: false, needed: { id: 'database-terms', kind: 'database-terms', message: 'Vercel needs you to accept the Neon Marketplace terms.', integration: 'neon', policyLinks: out.links } };
      }
      if (out.kind === 'action') {
        return { ok: false, needed: { id: 'database-dashboard', kind: 'database-dashboard', message: 'Finish adding the database in the Vercel dashboard.', ...(out.url ? { actionUrl: out.url } : {}) } };
      }
      if (out.kind === 'plan-rejected' && !planRetried) {
        planRetried = true;
        const free = out.plans.find((p) => /free/i.test(p) && p !== plan);
        if (free) {
          plan = free;
          continue;
        }
      }
      return fail('cli', 'The Vercel CLI could not add the database.');
    }
    return fail('cli', 'The Vercel CLI could not add the database.');
  } catch (e) {
    const timedOut = e instanceof Error && /timed out/i.test(e.message);
    return timedOut ? fail('timeout', 'Adding the database took too long.') : fail('unknown', 'Adding the database failed.');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
