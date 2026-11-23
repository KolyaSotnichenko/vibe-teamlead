/**
 * The preview's recipe: `preview.json` at a project's root says how the app runs the project,
 * where its files don't let the preview work that out. The file comes from the repository, so
 * it is checked before anything in it is used: a strict shape with limits, folders that stay
 * inside the project, commands the Bash denylist allows (as agents' dev servers), and no
 * variable that changes what a command runs. An unusable file is passed over, with the
 * reason (a sentence the interface can translate: say.ts). No file access, no Electron imports.
 */

import { z } from 'zod';

import type { PreviewRecipe, PreviewRecipeSource } from '../../shared/types/preview';
import type { PreviewService } from '../../shared/types/project';
import { FORBIDDEN_ENV } from '../ai/dev-servers/forbidden-env';
import { validateCommand } from '../ai/security/bash-validator';
import type { ProjectFiles } from '../ai/verification/detect-checks';
import { say } from '../say';
import { proposePreview } from './detect-services';

export const RECIPE_FILE = 'preview.json';

const MAX_BYTES = 64 * 1024;
const MAX_SERVICES = 12;
const MAX_COMMANDS = 12;
const MAX_COMMAND = 500;
const MAX_DIR = 200;
const MAX_READY = 200;
const MAX_VARIABLES = 50;
const MAX_VALUE = 2000;

const NAME = /^[\w-]{1,40}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const Env = z.record(z.string().regex(ENV_NAME), z.string().max(MAX_VALUE)).refine((env) => Object.keys(env).length <= MAX_VARIABLES, `has more than ${MAX_VARIABLES} variables`);
const Dir = z.string().max(MAX_DIR);
const Command = z.string().min(1).max(MAX_COMMAND);
const Commands = z.array(z.strictObject({ dir: Dir, command: Command })).max(MAX_COMMANDS);

const Service = z.strictObject({
  name: z.string().regex(NAME),
  dir: Dir,
  command: Command,
  portEnv: z.string().regex(ENV_NAME).max(100).optional(),
  page: z.boolean().optional(),
  urlEnv: z.record(z.string().regex(ENV_NAME), z.string().regex(NAME)).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ready: z.string().regex(/^\//).max(MAX_READY).optional(),
  env: Env.optional(),
});

const Recipe = z.strictObject({
  version: z.literal(1),
  kind: z.enum(['web', 'desktop', 'mobile', 'none']),
  services: z.array(Service).max(MAX_SERVICES).optional(),
  steps: z.strictObject({ install: Commands.optional(), build: Commands.optional(), migrate: Commands.optional(), seed: Commands.optional() }).optional(),
  env: Env.optional(),
});

export type ParsedRecipe = { ok: true; recipe: PreviewRecipe } | { ok: false; reason: string };

const pathOf = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((text, part) => (typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${String(part)}` : String(part)), '');

/** Inside the project: relative, with `/`, no `.` or `..` step. '' is the root. */
function staysInside(dir: string): boolean {
  if (dir === '') return true;
  if (dir.startsWith('/') || dir.includes('\\') || /^[A-Za-z]:/.test(dir)) return false;
  return dir.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The first thing wrong that the shape alone can't say, or null */
function problemIn(recipe: PreviewRecipe): string | null {
  const services = recipe.services ?? [];
  if (recipe.kind === 'web' && recipe.services) {
    if (new Set(services.map((s) => s.name)).size !== services.length) return say('recipeSameName', 'services: two services have the same name.');
    if (services.filter((s) => s.page).length !== 1) return say('recipeOnePage', 'services: exactly one service must be the page ("page": true).');
  }
  const commands: Array<{ at: string; dir: string; command: string }> = [
    ...services.map((s, i) => ({ at: `services[${i}]`, dir: s.dir, command: s.command })),
    ...(['install', 'build', 'migrate', 'seed'] as const).flatMap((step) => (recipe.steps?.[step] ?? []).map((c, i) => ({ at: `steps.${step}[${i}]`, ...c }))),
  ];
  for (const { at, dir, command } of commands) {
    if (!staysInside(dir)) return say('recipeDir', `${at}.dir must be a folder inside the project, written with "/" from its root ("" for the root itself).`, { at });
    const [allowed, reason] = validateCommand(command);
    if (!allowed) return say('recipeCommand', `${at}.command is not allowed: ${reason}`, { at, reason: reason ?? '' });
  }
  const variables: Array<{ at: string; name: string }> = [
    ...Object.keys(recipe.env ?? {}).map((name) => ({ at: `env.${name}`, name })),
    ...services.flatMap((s, i) => [
      ...Object.keys(s.env ?? {}).map((name) => ({ at: `services[${i}].env.${name}`, name })),
      ...Object.keys(s.urlEnv ?? {}).map((name) => ({ at: `services[${i}].urlEnv.${name}`, name })),
      ...(s.portEnv ? [{ at: `services[${i}].portEnv (${s.portEnv})`, name: s.portEnv }] : []),
    ]),
  ];
  const forbidden = variables.find((v) => FORBIDDEN_ENV.test(v.name));
  if (forbidden) return say('recipeVariable', `${forbidden.at} can't be set: it changes what a command runs.`, { at: forbidden.at });
  for (const [i, service] of services.entries()) {
    const missing = Object.entries(service.urlEnv ?? {}).find(([, target]) => !services.some((s) => s.name === target));
    if (missing) {
      const at = `services[${i}].urlEnv.${missing[0]}`;
      return say('recipeUrlEnv', `${at} names "${missing[1]}", which is not one of the services.`, { at, target: missing[1] });
    }
  }
  return null;
}

/** `preview.json` as a recipe, or why it can't be used: one short sentence naming the first problem. */
export function parseRecipe(text: string): ParsedRecipe {
  if (Buffer.byteLength(text, 'utf-8') > MAX_BYTES) return { ok: false, reason: say('recipeTooLarge', 'The file is larger than 64 KiB.') };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: say('recipeNotJson', 'The file is not valid JSON.') };
  }
  const parsed = Recipe.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = pathOf(issue.path) || RECIPE_FILE;
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.join(', ').slice(0, 200);
      return { ok: false, reason: say('recipeUnknownKeys', `${at} has keys a recipe does not have: ${keys}`, { at, keys }) };
    }
    const problem = issue.message.slice(0, 200);
    return { ok: false, reason: say('recipeShape', `${at}: ${problem}`, { at, problem }) };
  }
  const recipe = parsed.data as PreviewRecipe;
  const problem = problemIn(recipe);
  return problem ? { ok: false, reason: problem } : { ok: true, recipe };
}

export interface ResolvedRecipe {
  recipe: PreviewRecipe;
  source: PreviewRecipeSource;
  /** Where the services came from: a file recipe without services takes them from the saved ones or the proposal */
  servicesFrom: PreviewRecipeSource;
  /** preview.json is there and was not used: why */
  invalid?: string;
}

/** Every folder a recipe runs something in */
const dirsOf = (recipe: PreviewRecipe): string[] => [
  ...(recipe.services ?? []).map((service) => service.dir),
  ...(['install', 'build', 'migrate', 'seed'] as const).flatMap((step) => (recipe.steps?.[step] ?? []).map((command) => command.dir)),
];

/**
 * The recipe a start uses, first that applies: the project's `preview.json`, the services the
 * owner saved, or the proposal from the project's files when it names exactly one page (so
 * nobody is asked). A file recipe without services takes them from the next two. `none`: no
 * source gives a page, and the owner is asked. An unusable file is passed over, with why:
 * one that doesn't parse, or one with a folder that is a link out of the project (`contained`,
 * asked of the real folders by a caller that has them).
 */
export function resolveRecipe(input: ProjectFiles & { saved: PreviewService[]; contained?: (dir: string) => boolean }): ResolvedRecipe {
  const { files, read, saved, contained } = input;
  const parsed = files.includes(RECIPE_FILE) ? parseRecipe(read(RECIPE_FILE) ?? '') : undefined;
  const outside = parsed?.ok && contained ? dirsOf(parsed.recipe).find((dir) => dir !== '' && !contained(dir)) : undefined;
  const reason = parsed && !parsed.ok ? parsed.reason : outside !== undefined ? say('recipeLink', `The folder ${outside} leads out of the project.`, { dir: outside }) : undefined;
  const invalid = reason ? { invalid: reason } : {};
  const file = parsed?.ok && outside === undefined ? parsed.recipe : undefined;
  if (file && (file.kind !== 'web' || file.services)) return { recipe: file, source: 'file', servicesFrom: file.services ? 'file' : 'none' };

  /** The saved services, else a proposal that leaves nothing to choose: one service, or one that could be the page */
  const detected = (): { services: PreviewService[]; source: 'settings' | 'proposal' | 'none' } => {
    if (saved.length) return { services: saved, source: 'settings' };
    const { services, pageCandidates } = proposePreview({ files, read });
    const clear = services.filter((service) => service.page).length === 1 && (services.length === 1 || pageCandidates === 1);
    return clear ? { services, source: 'proposal' } : { services: [], source: 'none' };
  };
  const { services, source } = detected();
  if (file) return { recipe: { ...file, services }, source: source === 'none' ? 'none' : 'file', servicesFrom: source };
  return { recipe: { version: 1, kind: 'web', services }, source, servicesFrom: source, ...invalid };
}
