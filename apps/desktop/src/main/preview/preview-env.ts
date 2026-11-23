/**
 * The variables a preview service gets, each with where its value came from. The preview
 * starts its services with exactly these (`envOf`), and the Environment panel shows them, so
 * the two never differ. Sources, in the order they apply: the root's and the service folder's
 * `.env.example`, the preview's database (connection settings it has no database for set
 * empty, so the app can't reach a real one), the compose file's other services it started
 * (queues, storage, search: compose-env.ts), its mail catcher, the recipe's values (preview.json),
 * the owner's values for all services, the other services' preview addresses, the service's own
 * recipe values, the owner's values for this service, and the port. A recipe value only replaces
 * an example's value or adds a variable: never what the preview set itself, never the owner's.
 * Never `.env`. Pure: no file access.
 */

import type { PreviewEnvService, PreviewEnvSource, PreviewEnvVar } from '../../shared/types/preview';
import type { ProjectSettings } from '../../shared/types/project';
import { composeEnv, type ComposeWiring } from '../ai/verification/compose-env';
import { composeServices } from '../ai/verification/compose-services';
import { composeFilesInOrder, imagesFromComposeFiles, isConnectionSetting, type StartedService, serviceEnv } from '../ai/verification/detect-checks';
import { previewAddressesByExamplePort, rewriteExampleUrls } from './example-urls';
import { mailEnv, needsMail } from './preview-mail';
import { resolveRecipe } from './recipe';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Each key's value as serviceEnv reads it */
function exampleValues(text: string | null): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (text ?? '').split('\n')) {
    const match = LINE.exec(line);
    if (match) values.set(match[1], match[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return values;
}

/** What a recipe value may replace: an example's value, or another recipe value. Everything else stays. */
const RECIPE_REPLACES = new Set<PreviewEnvSource>(['example', 'exampleDir', 'recipe']);

function applyRecipe(vars: Map<string, PreviewEnvVar>, recipe: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(recipe ?? {})) {
    const before = vars.get(name);
    if (before && !RECIPE_REPLACES.has(before.source)) continue;
    vars.set(name, { name, value, source: 'recipe', ...(before ? { automatic: { value: before.value, source: before.source } } : {}) });
  }
}

export interface BaseEnvInput {
  /** The service's folder, '' for the root */
  dir: string;
  /** `.env.example` at the root, null when there is none */
  rootExample: string | null;
  /** `.env.example` in the folder (null for the root itself) */
  dirExample: string | null;
  /** The preview's database services */
  started: StartedService[];
  /** The compose file's other services, and those of them that started */
  compose?: ComposeWiring;
  /** The mail catcher's SMTP port, when it runs */
  mailPort?: number;
  /** The recipe's values for every service (`env` in preview.json) */
  recipe?: Record<string, string>;
  /** The owner's values for every service (`previewEnv`) */
  overrides?: Record<string, string>;
  /** Before the start: the database's and the mail catcher's values aren't known yet */
  pending?: boolean;
}

/** A folder's variables: what libraries, migrations and seeds run with, and what each service starts from. */
export function baseEnvVars(input: BaseEnvInput): PreviewEnvVar[] {
  const root = exampleValues(input.rootExample);
  const own = input.dir ? exampleValues(input.dirExample) : new Map<string, string>();
  const examples = [input.rootExample, input.dir ? input.dirExample : null].filter((text): text is string => text !== null).join('\n');
  const compose = input.compose ?? { planned: [], started: [] };
  const env = serviceEnv(examples, input.started, compose);
  const wired = composeEnv(examples, compose);
  const vars = new Map<string, PreviewEnvVar>();
  const set = (name: string, value: string, source: PreviewEnvSource, service?: string) => {
    const pending = input.pending && (source === 'database' || source === 'mail' || source === 'service');
    vars.set(name, { name, value: pending ? '' : value, source, ...(service ? { service } : {}), ...(pending ? { pending: true } : {}) });
  };
  for (const [name, value] of Object.entries(env)) {
    const fromCompose = wired.get(name);
    // A service that didn't start: empty on purpose, so the app can't reach a real one
    if (fromCompose) set(name, value, fromCompose.started || input.pending ? 'service' : 'blocked', fromCompose.service);
    // A connection setting that is here at all is the preview's: serviceEnv keeps none of the examples'.
    // So it is the database's also where the example happens to hold the same value (DB_HOST=127.0.0.1).
    else if (isConnectionSetting(name, value)) set(name, value, 'database');
    else if (own.has(name) && own.get(name) === value) set(name, value, 'exampleDir');
    else if (!own.has(name) && root.has(name) && root.get(name) === value) set(name, value, 'example');
    else set(name, value, 'database');
  }
  for (const name of [...root.keys(), ...own.keys()]) if (!vars.has(name)) set(name, '', 'blocked');
  if (input.mailPort) for (const [name, value] of Object.entries(mailEnv(examples, input.mailPort))) set(name, value, 'mail');
  // For a service in a folder: what only the root's example names, which every service gets
  if (input.dir) for (const [name, v] of vars) if (root.has(name) && !own.has(name)) vars.set(name, { ...v, shared: true });
  applyRecipe(vars, input.recipe);
  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    const before = vars.get(name);
    vars.set(name, { name, value, source: 'override', ...(before ? { automatic: { value: before.value, source: before.source } } : {}) });
  }
  return [...vars.values()];
}

export interface ServiceEnvInput {
  /** Example port → that service's preview address */
  byExamplePort: Map<number, string>;
  urlEnv?: Record<string, string>;
  /** Each service's preview address */
  urls: Record<string, string>;
  /** The recipe's values for this service (its `env` in preview.json) */
  recipe?: Record<string, string>;
  /** The owner's values for this service (`previewServiceEnv`) */
  serviceOverrides?: Record<string, string>;
  portEnv: string;
  port?: number;
  /** Before the start: addresses and the port aren't known yet */
  pending?: boolean;
}

/** One service's variables, on top of its folder's. */
export function serviceEnvVars(base: PreviewEnvVar[], input: ServiceEnvInput): PreviewEnvVar[] {
  const vars = new Map(base.map((v) => [v.name, { ...v }]));
  const rewritten = rewriteExampleUrls(Object.fromEntries(base.map((v) => [v.name, v.value])), input.byExamplePort);
  const address = (name: string, value: string) =>
    vars.set(name, { name, value: input.pending ? '' : value, source: 'address', ...(input.pending ? { pending: true } : {}) });
  for (const v of base) {
    if (rewritten[v.name] === v.value) continue;
    if (v.source === 'override') vars.set(v.name, { ...v, value: rewritten[v.name] });
    else address(v.name, rewritten[v.name]);
  }
  for (const [name, other] of Object.entries(input.urlEnv ?? {})) if (input.urls[other]) address(name, input.urls[other]);
  // The service's own recipe values: a local address among them is pointed at the preview's port, as the shared ones are
  applyRecipe(vars, input.recipe ? rewriteExampleUrls(input.recipe, input.byExamplePort) : undefined);
  for (const [name, value] of Object.entries(input.serviceOverrides ?? {})) {
    const before = vars.get(name);
    vars.set(name, { name, value, source: 'serviceOverride', ...(before ? { automatic: { value: before.value, source: before.source } } : {}) });
  }
  vars.set(input.portEnv, {
    name: input.portEnv,
    value: input.port ? String(input.port) : '',
    source: 'port',
    ...(input.port ? {} : { pending: true }),
  });
  return [...vars.values()];
}

/** The variables as a process environment; the port is passed by the dev server itself. */
export function envOf(vars: PreviewEnvVar[]): Record<string, string> {
  return Object.fromEntries(vars.filter((v) => v.source !== 'port').map((v) => [v.name, v.value]));
}

/** The root's and a folder's `.env.example`, when tracked */
export function exampleTexts(files: string[], read: (path: string) => string | null, dir: string): Pick<BaseEnvInput, 'rootExample' | 'dirExample'> {
  const text = (path: string) => (files.includes(path) ? (read(path) ?? '') : null);
  return { rootExample: text('.env.example'), dirExample: dir ? text(`${dir}/.env.example`) : null };
}

const PLACEHOLDER_URLS: Record<StartedService['kind'], string> = {
  postgres: 'postgresql://preview:preview@127.0.0.1:1/preview',
  mysql: 'mysql://preview:preview@127.0.0.1:1/preview',
  redis: 'redis://127.0.0.1:1',
  mongo: 'mongodb://preview:preview@127.0.0.1:1/preview',
};

export interface PlannedEnv {
  databases: string[];
  composeServices: string[];
  mail: boolean;
  services: PreviewEnvService[];
}

/**
 * What each service will get at the next start, from the project's files alone: the services
 * and values of the recipe a start would use (recipe.ts), the database kinds and the other
 * services compose names, the mail catcher when the examples configure SMTP; their addresses
 * and the ports are pending. Pure.
 */
export function plannedEnv(
  settings: Pick<ProjectSettings, 'previewServices' | 'previewEnv' | 'previewServiceEnv' | 'previewPendingRecipe'>,
  files: string[],
  read: (path: string) => string | null,
): PlannedEnv {
  const { recipe } = resolveRecipe({ files, read, saved: settings.previewServices ?? [], pending: settings.previewPendingRecipe });
  const services = recipe.kind === 'web' ? (recipe.services ?? []) : [];
  const composeContents = composeFilesInOrder(files).map((file) => read(file) ?? '');
  const kinds = imagesFromComposeFiles(composeContents).map((image) => image.kind);
  const compose = { planned: composeServices(composeContents), started: [] };
  const started = kinds.map((kind) => ({ kind, url: PLACEHOLDER_URLS[kind] }));
  const allExamples = [...new Set(['', ...services.map((s) => s.dir)])]
    .map((dir) => (dir ? `${dir}/.env.example` : '.env.example'))
    .filter((path) => files.includes(path))
    .map((path) => read(path) ?? '')
    .join('\n');
  const mail = needsMail(allExamples);
  const urls = Object.fromEntries(services.map((s) => [s.name, `http://preview-${s.name}.invalid`]));
  const byExamplePort = previewAddressesByExamplePort(services, urls, read);
  return {
    databases: kinds,
    composeServices: compose.planned.map((service) => service.name),
    mail,
    services: services.map((service) => ({
      service: service.name,
      dir: service.dir,
      vars: serviceEnvVars(
        baseEnvVars({ dir: service.dir, ...exampleTexts(files, read, service.dir), started, compose, mailPort: mail ? 1 : undefined, recipe: recipe.env, overrides: settings.previewEnv, pending: true }),
        { byExamplePort, urlEnv: service.urlEnv, urls, recipe: service.env, serviceOverrides: settings.previewServiceEnv?.[service.name], portEnv: service.portEnv ?? 'PORT', pending: true },
      ),
    })),
  };
}
