/**
 * One of the app's checks: the project starts. In the clean copy verify-task.ts made, with the
 * copy's throwaway database and compose services, the app starts the project by its recipe
 * (preview/recipe.ts: the copy's preview.json, the owner's saved services, or what the files
 * propose), as the Preview does: the recipe's build, migrations and seed, then the services. It
 * passes when every service came up, the page answers below 500, and a moment later every
 * service still runs. Everything it started is stopped, whatever happens. No Electron imports.
 */

import type { StartsWhy } from '../../../shared/utils/verification-summary';
import { resolve } from 'node:path';

import type { PreviewRecipeCommand } from '../../../shared/types/preview';
import { STARTS_CHECK_COMMAND } from '../../../shared/utils/verification-summary';
import type { PreviewService } from '../../../shared/types/project';
import { isPathContained } from '../security/path-containment';
import { workspaceLibraries } from '../../preview/detect-services';
import { baseEnvVars, envOf, exampleTexts } from '../../preview/preview-env';
import { resolveRecipe } from '../../preview/recipe';
import { startRecipeServices, type StartServicesDeps } from '../../preview/start-services';
import type { ComposeWiring } from './compose-env';
import type { Check, StartedService } from './detect-checks';

export const STARTS_CHECK: Check = { name: 'starts', command: STARTS_CHECK_COMMAND };

/** As verify-task.ts's CheckOutcome: the same words, without importing it back */
export type StartsOutcome = 'passed' | 'failed' | 'timed_out' | 'unavailable';

const SERVER_TIMEOUT_MS = 180_000;
const SETTLE_MS = 5000;
/** The whole check's time when the caller says none */
const CHECK_TIMEOUT_MS = 20 * 60_000;
const TAIL_CHARS = 4000;
/** A tool the start needs is not on this computer: that says nothing about the task */
const MISSING_TOOL = /command not found|not recognized as an internal or external command|ENOENT|exit code 127|exited with code 127/i;

export interface StartsCheckOptions {
  /** The copy */
  cwd: string;
  files: string[];
  read: (path: string) => string | null;
  /** The project's saved preview services, for a project with no preview.json */
  saved: PreviewService[];
  /** The copy's throwaway databases */
  started: StartedService[];
  /** The copy's compose services */
  compose: ComposeWiring;
  /** A reason the check can't say anything this run (a compose port it needs is taken) */
  cannot?: string;
  /** What `cannot` is, for the task's window */
  cannotWhy?: StartsWhy;
  /**
   * The services the commit the task started from starts. Without a recipe of its own the task
   * starts what its files propose, and a service that is no longer found would not be missed.
   */
  expectServices?: string[];
  /** Goes into the servers' names: the app's dev servers are told apart by name, and two runs may be at work at once */
  runId?: string;
  runCommand: (command: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; output: string; timedOut?: boolean }>;
  deps: StartServicesDeps;
  /** How long the services must stay up after the page answered */
  settleMs?: number;
  /** The whole check's time: past it, it stops and has run out of time */
  timeoutMs?: number;
  /**
   * The copy has a throwaway SQL database of its own and nothing points elsewhere (verify-task's rule
   * for migrations): only then do the recipe's migrations and seed run. They can destroy data.
   */
  migratable?: boolean;
  signal?: AbortSignal;
}

export interface StartsResult {
  outcome: StartsOutcome;
  /** Why it could not judge the task, when unavailable */
  why?: StartsWhy;
  tail?: string;
}

class Aborted extends Error {}
class OutOfTime extends Error {}

const tail = (text: string) => text.slice(-TAIL_CHARS);

/** Null: there is nothing to start here (another kind of project, or no single page). */
export async function startsCheck(options: StartsCheckOptions): Promise<StartsResult | null> {
  const { cwd, files, read } = options;
  const { recipe, servicesFrom } = resolveRecipe({ files, read, saved: options.saved, contained: (dir) => isPathContained(resolve(cwd, dir), cwd).contained });
  const services = recipe.kind === 'web' ? (recipe.services ?? []) : [];
  if (services.filter((service) => service.page).length !== 1) {
    // Nothing to start here, while the base starts something: the task may have lost its start
    if (recipe.kind === 'web' && options.expectServices?.length) {
      return { outcome: 'unavailable', why: { reason: 'nothing', names: options.expectServices }, tail: `Nothing could be started, while the commit this task started from starts ${options.expectServices.join(', ')}. Its start may be gone (a renamed dev script?): look at it.` };
    }
    return null;
  }
  if (options.cannot) return { outcome: 'unavailable', ...(options.cannotWhy ? { why: options.cannotWhy } : {}), tail: options.cannot };
  const deadline = Date.now() + (options.timeoutMs ?? CHECK_TIMEOUT_MS);
  const left = () => Math.max(1, deadline - Date.now());

  /** A folder's variables: its examples, the copy's own database and services, the recipe's values. Never `.env`. */
  const varsFor = (dir: string) =>
    baseEnvVars({ dir, ...exampleTexts(files, read, dir), started: options.started, compose: options.compose, recipe: recipe.env });
  const check = () => {
    if (options.signal?.aborted) throw new Aborted();
    if (Date.now() > deadline) throw new OutOfTime();
  };
  const servers: string[] = [];
  const stopAll = async () => {
    for (const name of servers.splice(0).reverse()) await options.deps.stopServer(name).catch(() => false);
  };

  const step = async (command: PreviewRecipeCommand): Promise<StartsResult | null> => {
    check();
    const result = await options.runCommand(command.command, resolve(cwd, command.dir), envOf(varsFor(command.dir)));
    check();
    if (result.timedOut) return { outcome: 'timed_out', tail: tail(`${command.command}\n${result.output}`) };
    if (result.code === 0) return null;
    if (result.code === 127 || MISSING_TOOL.test(result.output)) return { outcome: 'unavailable', why: { reason: 'tool' }, tail: tail(`${command.command}\n${result.output}`) };
    return { outcome: 'failed', tail: tail(`${command.command}\n${result.output}`) };
  };

  try {
    // The recipe's own install (verify has run what it detects), what the services need built first, then the
    // recipe's migrations and seed: only on the copy's own throwaway database, never one the owner pointed at
    const build: PreviewRecipeCommand[] = recipe.steps?.build ?? workspaceLibraries({ files, read }, services).map((library) => ({ dir: library.dir, command: library.command }));
    const database = options.migratable ? [...(recipe.steps?.migrate ?? []), ...(recipe.steps?.seed ?? [])] : [];
    for (const command of [...(recipe.steps?.install ?? []), ...build, ...database]) {
      const failed = await step(command);
      if (failed) return failed;
    }

    let started;
    try {
      started = await startRecipeServices(
        {
          services,
          root: cwd,
          specDir: resolve(cwd, '.vibe-teamlead', 'specs', 'starts-check'),
          serverName: (service) => (options.runId ? `starts-${options.runId}-${service.name}` : `starts-${service.name}`),
          read,
          baseVars: varsFor,
          timeoutMs: Math.min(SERVER_TIMEOUT_MS, left()),
          check,
          onServer: (name) => servers.push(name),
        },
        options.deps,
      );
    } catch (error) {
      if (error instanceof Aborted || error instanceof OutOfTime) throw error;
      const { message, logTail = '' } = error as Error & { logTail?: string };
      return MISSING_TOOL.test(logTail) ? { outcome: 'unavailable', why: { reason: 'tool' }, tail: tail(`${message}\n${logTail}`) } : { outcome: 'failed', tail: tail(`${message}\n${logTail}`) };
    }

    // A service on another port than the project expects: an address the project hard-codes reaches whatever holds that port
    const moved = Object.entries(started.displaced);
    if (moved.length) {
      return { outcome: 'unavailable', why: { reason: 'port', names: moved.map(([name]) => name) }, tail: moved.map(([name, ports]) => `${name} could not have port ${ports.ownPort}, which is in use on this computer (an open preview, your own dev server…), so the project could not be started as it expects.`).join('\n') };
    }
    const page = await options.deps.probe(`${started.url}/`);
    check();
    if (page.status === undefined || page.status >= 500) {
      return { outcome: 'failed', tail: `The page did not answer: ${page.status ?? page.error ?? 'no answer'} at ${started.url}/` };
    }
    // Up is not enough: a service that crashes right after its first answer is caught here
    await new Promise((resolveWait) => setTimeout(resolveWait, options.settleMs ?? SETTLE_MS));
    check();
    for (const service of started.ordered) {
      if (await options.deps.portFree(started.ports[service.name])) {
        const log = options.deps.readLog(started.logs[service.name]) ?? '';
        return { outcome: 'failed', tail: tail(`${service.name} stopped right after it started\n${log}`) };
      }
    }
    // Services the project's own recipe names are what it means to start; detected ones may just not be found any more
    const missing = servicesFrom === 'file' ? [] : (options.expectServices ?? []).filter((name) => !services.some((service) => service.name === name));
    if (missing.length) {
      return {
        outcome: 'unavailable',
        why: { reason: 'missing', names: missing },
        tail: `The project started, but without ${missing.join(', ')}, which the commit this task started from starts. Its start may be gone (a renamed dev script?), or it was removed on purpose: look at it.`,
      };
    }
    return { outcome: 'passed' };
  } catch (error) {
    if (error instanceof Aborted) return { outcome: 'unavailable', why: { reason: 'stopped' }, tail: 'The check was stopped.' };
    if (error instanceof OutOfTime) return { outcome: 'timed_out', tail: 'Starting the project took longer than the check may take.' };
    throw error;
  } finally {
    await stopAll();
  }
}
