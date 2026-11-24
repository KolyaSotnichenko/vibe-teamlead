/**
 * The app QA works against: the task's own code, started by the project's recipe (preview.json, the
 * owner's saved services, or what the files propose), with a fresh database and the compose file's
 * other services as throwaway containers, the recipe's migrations and seed run on that database.
 * QA used to start databases itself with Docker in Bash, and some sessions ended without one
 * ("no API/DB running"), so the screens a design draws with data were never shown. It keeps running
 * for the task's next sessions and is stopped with the task's other resources. No Electron imports.
 */

import { resolve } from 'node:path';

import type { PreviewService } from '../../../shared/types/project';
import { workspaceLibraries } from '../../preview/detect-services';
import { examplePort } from '../../preview/example-urls';
import { baseEnvVars, databaseStepVars, envOf, exampleTexts } from '../../preview/preview-env';
import { resolveRecipe } from '../../preview/recipe';
import { type StartServicesDeps, startRecipeServices } from '../../preview/start-services';
import { isPathContained } from '../security/path-containment';
import { composeMovedNotice, createRunNetwork, startComposeServices } from '../verification/compose-runner';
import { bucketsOf, composeSecrets, composeServices } from '../verification/compose-services';
import { composeFilesInOrder, imagesFromComposeFiles, isConnectionSetting, namesDatabase, ownDatabaseSetting } from '../verification/detect-checks';
import { type DockerRun, startTestServices, VERIFY_LABEL } from '../verification/test-services';

export interface TaskAppDeps {
  docker: DockerRun;
  /** The worktree's files, paths with `/` */
  listFiles: () => Promise<string[]>;
  read: (path: string) => string | null;
  /** The install command when the worktree's dependencies are missing (`pnpm install`), else null */
  installCommand: () => string | null;
  runCommand: (command: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; output: string }>;
  servers: StartServicesDeps;
  /** Whether a compose service's local port answers (default: a real connection) */
  portOpen?: (port: number) => Promise<boolean>;
}

export interface TaskAppOptions {
  worktree: string;
  specDir: string;
  /** Tells this app's containers apart from other runs */
  label: string;
  saved?: PreviewService[];
  /** The owner's values from Settings: they win, and are never shown */
  projectEnv?: Record<string, string>;
}

export type TaskAppResult =
  | { ok: true; url: string; reused: boolean; services: string[]; database?: string; notices?: string[] }
  | { ok: false; reason: string };

const SERVER_TIMEOUT_MS = 180_000;
const TAIL = 2000;
/** The shortest end of a value masked at the start of a line */
const PART = 6;
/** A real env file in the repository: tools may read it before anything the app sets */
const COMMITTED_ENV = /(^|\/)\.env(\.[\w-]+)?$/;

class Stopped extends Error {
  constructor() {
    super('The app was stopped while it started');
  }
}

/** The app of one task. */
export function createTaskApp(options: TaskAppOptions, deps: TaskAppDeps) {
  const { worktree, specDir, label } = options;
  const projectEnv = options.projectEnv ?? {};
  let running: Extract<TaskAppResult, { ok: true }> | undefined;
  let starting: Promise<TaskAppResult> | undefined;
  /** Bumped by every stop: a start that began before it ends at its next step */
  let generation = 0;
  const servers: string[] = [];
  const stops: Array<() => Promise<void>> = [];
  /** Values never shown: the owner's, and those of the containers a start made */
  const secrets: string[] = Object.values(projectEnv);
  /**
   * Longest first. A text that was cut before it got here (a server's log tail) may begin a line with
   * the end of a value: such a start of a line is masked too.
   */
  const redact = (text: string) => {
    const values = [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
    const whole = values.reduce((out, value) => out.split(value).join('***'), text);
    return whole
      .split('\n')
      .map((line) => {
        for (const value of values) {
          for (let size = value.length - 1; size >= PART; size -= 1) if (line.startsWith(value.slice(-size))) return `***${line.slice(size)}`;
        }
        return line;
      })
      .join('\n');
  };
  /** The end of a text, masked first */
  const tailOf = (text: string) => redact(text).slice(-TAIL);

  const release = async () => {
    for (const name of servers.splice(0).reverse()) await deps.servers.stopServer(name).catch(() => false);
    for (const stopOne of stops.splice(0).reverse()) await stopOne().catch(() => {});
    // Anything else with this app's label: a container whose start was cut short has no stop of its own
    const left = await deps.docker(['ps', '-aq', '--filter', `label=${VERIFY_LABEL}=${label}`]).catch(() => ({ ok: false, stdout: '' }));
    for (const id of left.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) await deps.docker(['rm', '-f', '-v', id]).catch(() => undefined);
    running = undefined;
  };

  const run = async (mine: number): Promise<TaskAppResult> => {
    const check = () => {
      if (mine !== generation) throw new Stopped();
    };
    try {
      const files = await deps.listFiles();
      const read = deps.read;
      check();
      const { recipe } = resolveRecipe({ files, read, saved: options.saved ?? [], contained: (dir) => isPathContained(resolve(worktree, dir), worktree).contained });
      const services = recipe.kind === 'web' ? (recipe.services ?? []) : [];
      if (services.filter((service) => service.page).length !== 1) {
        return { ok: false, reason: 'The project has no recipe with a single page to start (preview.json): start the servers with start_dev_server instead.' };
      }

      // The database and the compose file's other services, on one network, as for the app's checks
      const composeTexts = composeFilesInOrder(files).map((file) => read(file) ?? '');
      const images = imagesFromComposeFiles(composeTexts);
      const compose = composeServices(composeTexts);
      const network = images.length || compose.length ? await createRunNetwork(deps.docker, VERIFY_LABEL, label) : undefined;
      if (network) stops.push(network.remove);
      check();
      const database = await startTestServices(images, { docker: deps.docker, label, network: network?.name });
      stops.push(database.stop);
      secrets.push(...database.started.flatMap((service) => [service.url, new URL(service.url).password]));
      check();
      if (database.status === 'unavailable') {
        await release();
        return { ok: false, reason: redact(`The database could not start: ${database.reason ?? 'Docker did not answer'}`) };
      }
      // As the Preview does: a compose service takes the compose file's own host port when it is free (and
      // not one of the project's servers), so an address the project hard-codes (Azurite's 127.0.0.1:10000) reaches it
      const examples = ['', ...services.map((service) => service.dir ?? '')]
        .map((dir) => (dir ? `${dir}/.env.example` : '.env.example'))
        .filter((path, index, all) => files.includes(path) && all.indexOf(path) === index)
        .map((path) => read(path) ?? '')
        .join('\n');
      const ownPorts = services.map((service) => examplePort(service, read));
      const others = await startComposeServices(compose, {
        docker: deps.docker,
        labelKey: VERIFY_LABEL,
        labelValue: label,
        network: network?.name,
        buckets: bucketsOf(examples),
        pickPort: deps.servers.pickPort,
        ...(deps.portOpen ? { portOpen: deps.portOpen } : {}),
        hostPortFree: async (port) => !ownPorts.includes(port) && (await deps.servers.portFree(port)),
      });
      stops.push(others.stop);
      secrets.push(...composeSecrets(others.started));
      check();
      const notices = [...others.failed.map((failure) => `${failure.name}: ${failure.reason}`), ...others.moved.map(composeMovedNotice)];
      const wiring = { planned: compose, started: others.started };
      const varsFor = (dir: string) => baseEnvVars({ dir, ...exampleTexts(files, read, dir), started: database.started, compose: wiring, recipe: recipe.env });
      const envFor = (dir: string) => ({ ...envOf(varsFor(dir)), ...projectEnv });
      // A migration or a seed changes a database: no address from the recipe or the owner, only the fresh one's
      const heldBack = new Set<string>();
      const databaseEnvFor = (dir: string) => {
        const { vars, held } = databaseStepVars(varsFor(dir));
        for (const name of held) heldBack.add(name);
        const owners = Object.fromEntries(Object.entries(projectEnv).filter(([name, value]) => !isConnectionSetting(name, value)));
        return { ...envOf(vars), ...owners };
      };

      // Migrations and seed only on this fresh database: an address the owner's settings or a committed
      // env file give may be any database, so it is left alone (as the app's checks do)
      const ownedBy = ownDatabaseSetting(projectEnv)
        ?? files.find((path) => COMMITTED_ENV.test(path) && !/\.(example|sample)$/.test(path) && namesDatabase(read(path) ?? ''));
      const fresh = !ownedBy && database.started.some((service) => service.kind === 'postgres' || service.kind === 'mysql');
      if (ownedBy) notices.push(`${ownedBy} names a database, so the app uses that one: no migration or seed was run.`);
      const install = files.includes('package.json') ? deps.installCommand() : null;
      const build = recipe.steps?.build ?? workspaceLibraries({ files, read }, services).map((library) => ({ dir: library.dir, command: library.command }));
      const changesDatabase = (fresh ? [...(recipe.steps?.migrate ?? []), ...(recipe.steps?.seed ?? [])] : []).map((step) => ({ ...step, database: true }));
      const steps = [...(install ? [{ dir: '', command: install }] : []), ...(recipe.steps?.install ?? []), ...build, ...changesDatabase];
      for (const step of steps) {
        const env = 'database' in step ? databaseEnvFor(step.dir) : envFor(step.dir);
        const result = await deps.runCommand(step.command, resolve(worktree, step.dir), env);
        check();
        if (result.code !== 0) {
          await release();
          return { ok: false, reason: `${redact(step.command)} failed (exit ${result.code}):\n${tailOf(result.output)}` };
        }
      }

      if (heldBack.size) notices.push(`Migrations and seed ran only against the fresh database: they did not get ${[...heldBack].join(', ')} from the recipe.`);

      const up = await startRecipeServices(
        {
          services,
          root: worktree,
          specDir,
          serverName: (service) => `app-${service.name}`,
          read,
          baseVars: varsFor,
          timeoutMs: SERVER_TIMEOUT_MS,
          check,
          onServer: (name) => servers.push(name),
        },
        deps.servers,
      );
      check();
      running = {
        ok: true,
        url: up.url,
        reused: false,
        services: up.ordered.map((service) => `${service.name} at http://localhost:${up.ports[service.name]}`),
        ...(fresh ? { database: database.started.map((service) => service.kind).join(', ') } : {}),
        ...(notices.length ? { notices: notices.map(redact) } : {}),
      };
      return running;
    } catch (error) {
      const { message, logTail = '' } = error as Error & { logTail?: string };
      // After a stop, the stop releases what was started
      if (!(error instanceof Stopped)) await release();
      return { ok: false, reason: `${redact(message)}${logTail ? `\n${tailOf(logTail)}` : ''}` };
    }
  };

  /** The running app, the start under way, or a new start: one at a time */
  const start = async (): Promise<TaskAppResult> => {
    if (running) return { ...running, reused: true };
    if (!starting) {
      starting = run(generation).finally(() => {
        starting = undefined;
      });
    }
    return starting;
  };

  /** Ends a start under way at its next step, then stops everything this app started */
  const stop = async () => {
    generation += 1;
    await starting?.catch(() => undefined);
    await release();
  };

  return { start, stop };
}
