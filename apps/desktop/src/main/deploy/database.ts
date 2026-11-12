/**
 * Adds a Postgres database (Neon), Redis (Upstash) or Blob to the project's Vercel project with
 * the Vercel CLI. Neon and Upstash come through the Vercel Marketplace; Blob does not.
 *
 * Slug table (sources: the published `vercel@65.14.0` CLI, read as strings from the
 * `@vercel/vc-native-darwin-arm64@65.14.0` package, and the public Marketplace pages; the CLI was
 * never run):
 * - neon:  `integration add neon`, name `<proj>-db`, plan `free_v3`. Terms/installation slug `neon`.
 * - redis: `integration add upstash/upstash-kv` (`<integration>/<product>` is the CLI's own
 *   documented form; the Marketplace page vercel.com/marketplace/upstash lists integration
 *   `upstash`, product `upstash-kv` = Redis), name `<proj>-redis`. The free plan id is not
 *   published; `free_v3` is tried and the CLI's "Available plans" list drives one retry with a
 *   /free/ plan (same as Neon). Terms/installation slug `upstash`.
 * - blob:  NOT a Marketplace integration: `vercel blob create-store <name> --access private --yes
 *   -e production -e preview` (CLI source: POST /v1/storage/stores/blob, then
 *   POST /v1/storage/stores/{id}/connections; it uses the project linked in the cwd). Name
 *   `<proj>-blob` (the CLI needs 5+ characters). It has no `--no-env-pull`: the CLI pulls the
 *   development variables into `.env.local` of the private temp directory, which is removed.
 *
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
import type {
  DeployAddDatabaseResult,
  DeployDatabaseErrorKind,
  DeployProjectSettings,
  NeededFromYou,
} from '../../shared/types/deploy';
import { runVercelCli, type RunVercelCliResult } from './vercel-cli';

export interface DatabaseDeps {
  /** The Vercel CLI binary (`ensureVercelCli`). */
  binary: string;
  configDir: string;
  getToken: () => Promise<string | null>;
  /** The project's current stored settings (re-read after a lock wait so "already recorded" is fresh). */
  loadProject?: () => Promise<Project | undefined> | Project | undefined;
  /** Merges `patch` into the stored `project.settings.deploy`. Throws when it can't save. */
  saveSettings: (patch: Partial<DeployProjectSettings>) => Promise<void> | void;
  /** The signed-in Vercel user's id: the org of a project in the personal account. */
  userId?: string;
  /** Parent of the private link directory (default: the OS temp dir). */
  tmpRoot?: string;
  now?: () => Date;
  timeoutMs?: number;
}

export type IntegrationKind = 'neon' | 'redis' | 'blob';

interface IntegrationSpec {
  /** Marketplace argument of `integration add` (absent for Blob). */
  slug?: string;
  /** The installation/terms slug (`integration installations`, `accept-terms`). */
  installSlug?: string;
  suffix: string;
  label: string;
}

const INTEGRATIONS: Record<IntegrationKind, IntegrationSpec> = {
  neon: { slug: 'neon', installSlug: 'neon', suffix: '-db', label: 'Neon' },
  redis: { slug: 'upstash/upstash-kv', installSlug: 'upstash', suffix: '-redis', label: 'Upstash' },
  blob: { suffix: '-blob', label: 'Blob' },
};

export type DatabaseErrorKind = DeployDatabaseErrorKind;
export type AddDatabaseResult = DeployAddDatabaseResult;

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
function mentionsName(v: unknown, name: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.some((x) => mentionsName(x, name, depth + 1));
  if (!isRecord(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && /^(slug|name|integration|integrationSlug|integrationId)$/i.test(k) && val.trim().toLowerCase() === name) return true;
    if (mentionsName(val, name, depth + 1)) return true;
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

type PolicyLink = { name: string; url: string; host: string };

function policyLinks(raw: unknown): PolicyLink[] {
  const out: PolicyLink[] = [];
  const add = (name: unknown, url: unknown) => {
    const ok = httpsUrl(url);
    if (ok) out.push({ name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : ok, url: ok, host: new URL(ok).hostname });
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
  | { kind: 'terms'; links: PolicyLink[]; url?: string }
  | { kind: 'exists' }
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
    if (json.reason === 'INTEGRATION_TERMS_ACCEPTANCE_REQUIRED') return { kind: 'terms', links: policyLinks(json.policy_links ?? json.policyLinks), url: vercelUrl(json.verification_uri) };
    return { kind: 'action', url: vercelUrl(json.verification_uri) };
  }
  if (r.code === 0) return { kind: 'ok' };
  if (/already exists/i.test(text)) return { kind: 'exists' };
  const plans = plansFrom(text);
  if (plans) return { kind: 'plan-rejected', plans };
  return { kind: 'failed' };
}

/** Lowercase letters, digits and '-'; Neon/Vercel resource names are short. */
function resourceNameFor(project: Project, suffix: string): string {
  const base = (project.name || path.basename(project.path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${base || 'app'}${suffix}`;
}

const inflight = new Map<string, Promise<AddDatabaseResult>>();
/** Per project, so two services of one project never save settings at the same time. */
const projectTail = new Map<string, Promise<unknown>>();

export function addDatabase(project: Project, deps: DatabaseDeps, opts: { acceptTerms?: boolean } = {}): Promise<AddDatabaseResult> {
  return addIntegration(project, deps, { integration: 'neon', ...opts });
}

/** One run per project and integration at a time: a second caller joins the running one. */
export function addIntegration(project: Project, deps: DatabaseDeps, opts: { integration: IntegrationKind; acceptTerms?: boolean }): Promise<AddDatabaseResult> {
  const key = `${project.id}\0${opts.integration}`;
  const running = inflight.get(key);
  if (running) return running;
  const before = projectTail.get(project.id) ?? Promise.resolve();
  const p: Promise<AddDatabaseResult> = before
    .catch(() => undefined)
    .then(() => run(project, deps, opts))
    .finally(() => {
      inflight.delete(key);
      if (projectTail.get(project.id) === p) projectTail.delete(project.id);
    });
  inflight.set(key, p);
  projectTail.set(project.id, p);
  return p;
}

async function run(given: Project, deps: DatabaseDeps, opts: { integration: IntegrationKind; acceptTerms?: boolean }): Promise<AddDatabaseResult> {
  const kind = opts.integration;
  const spec = INTEGRATIONS[kind];
  let project = given;
  try {
    project = (await deps.loadProject?.()) ?? given;
  } catch {
    return fail('unknown', 'Adding the database failed.');
  }
  const deploy = project.settings.deploy;
  if (kind === 'neon' ? deploy?.database : deploy?.services?.[kind]) return { ok: true };
  const vercel = deploy?.vercel;
  const vercelDeploy = deploy ?? ({} as DeployProjectSettings);
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
    const cli = (args: string[]) =>
      runVercelCli([...args, ...scope], { binary: deps.binary, configDir: deps.configDir, token, cwd: dir, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    const pending = kind === 'neon' ? vercelDeploy.pendingDatabase : vercelDeploy.pendingServices?.[kind];
    const dbName = pending?.name ?? resourceNameFor(project, spec.suffix);
    const addArgs = (plan: string) =>
      kind === 'blob'
        ? ['blob', 'create-store', dbName, '--access', 'private', '--yes', '-e', 'production', '-e', 'preview']
        : ['integration', 'add', spec.slug as string, '--name', dbName, '--billing-plan', plan, '-e', 'production', '-e', 'preview', '--no-env-pull', '--json'];

    // The integration already installed on the team: the terms were accepted before.
    let installed = false;
    if (spec.installSlug) {
      const inst = await cli(['integration', 'installations', '--json']);
      installed = inst.code === 0 && mentionsName(parseCliJson(inst.stdout), spec.installSlug);
    }

    const record = async (): Promise<AddDatabaseResult> => {
      try {
        const addedAt = (deps.now?.() ?? new Date()).toISOString();
        if (kind === 'neon') await deps.saveSettings({ database: { provider: 'neon', addedAt }, pendingDatabase: undefined });
        else await deps.saveSettings({ services: { ...vercelDeploy.services, [kind]: { addedAt } }, pendingServices: withoutKey(vercelDeploy.pendingServices, kind) });
      } catch {
        return fail('saved-failed', "The database was added, but the app couldn't save that");
      }
      return { ok: true };
    };

    /** Run in the link dir, so the list is this project's resources. */
    const listedHere = async (): Promise<boolean> => {
      if (kind === 'blob') {
        const list = await cli(['blob', 'list-stores', '--json']);
        return list.code === 0 && mentionsName(parseCliJson(list.stdout), dbName.toLowerCase());
      }
      const list = await cli(['integration', 'list', '--json']);
      return list.code === 0 && mentionsName(parseCliJson(list.stdout), dbName.toLowerCase());
    };

    if (pending) {
      // A previous attempt may have created it (crash, timeout, failed save).
      if (await listedHere()) return record();
    } else {
      try {
        const mark = { name: dbName, at: (deps.now?.() ?? new Date()).toISOString() };
        await deps.saveSettings(kind === 'neon' ? { pendingDatabase: mark } : { pendingServices: { ...vercelDeploy.pendingServices, [kind]: mark } });
      } catch {
        return fail('unknown', 'Adding the database failed.');
      }
    }

    let plan = DEFAULT_PLAN;
    let planRetried = false;
    let accepted = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = classify(await cli(addArgs(plan)));
      if (out.kind === 'ok') return record();
      if (out.kind === 'exists') {
        // the name may be taken by another project or team: only this project's resource counts
        if (await listedHere()) return record();
        return fail('conflict', 'A database with this name already exists elsewhere on Vercel.');
      }
      if (out.kind === 'terms') {
        if (opts.acceptTerms && !accepted && !installed) {
          accepted = true;
          const acc = classify(await cli(['integration', 'accept-terms', spec.installSlug as string, '--yes', '--json']));
          if (acc.kind !== 'ok') return fail('cli', 'The Vercel CLI could not accept the terms.');
          continue;
        }
        if (accepted || out.links.length === 0) return dashboard(kind, out.url);
        return { ok: false, needed: { id: kind === 'neon' ? 'database-terms' : `${kind}-terms`, kind: 'database-terms', message: `Vercel needs you to accept the ${spec.label} Marketplace terms.`, integration: kind, policyLinks: out.links } };
      }
      if (out.kind === 'action') return dashboard(kind, out.url);
      if (out.kind === 'plan-rejected' && !planRetried) {
        planRetried = true;
        const free = out.plans.find((p) => /free/i.test(p) && p !== plan);
        if (free) {
          plan = free;
          continue;
        }
      }
      return fail('cli', 'The Vercel CLI could not add it.');
    }
    return fail('cli', 'The Vercel CLI could not add it.');
  } catch (e) {
    const timedOut = e instanceof Error && /timed out/i.test(e.message);
    return timedOut ? fail('timeout', 'Adding the database took too long.') : fail('unknown', 'Adding the database failed.');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function dashboard(kind: IntegrationKind, url?: string): AddDatabaseResult {
  return { ok: false, needed: { id: kind === 'neon' ? 'database-dashboard' : `${kind}-dashboard`, kind: 'database-dashboard', message: 'Finish adding it in the Vercel dashboard.', integration: kind, ...(url ? { actionUrl: url } : {}) } };
}

function withoutKey<T extends object>(obj: T | undefined, key: keyof T): T | undefined {
  if (!obj) return undefined;
  const { [key]: _removed, ...rest } = obj;
  return Object.keys(rest).length ? (rest as T) : undefined;
}
