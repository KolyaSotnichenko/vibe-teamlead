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
import { baseEnvVars, envOf, exampleTexts } from '../../preview/preview-env';
import { resolveRecipe } from '../../preview/recipe';
import { type StartServicesDeps, startRecipeServices } from '../../preview/start-services';
import { isPathContained } from '../security/path-containment';
import { bucketsOf, composeServices } from '../verification/compose-services';
import { composeMovedNotice, createRunNetwork, startComposeServices } from '../verification/compose-runner';
import { composeFilesInOrder, imagesFromComposeFiles } from '../verification/detect-checks';
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

export type TaskAppResult =
  | { ok: true; url: string; reused: boolean; services: string[]; database?: string; notices?: string[] }
  | { ok: false; reason: string };

const SERVER_TIMEOUT_MS = 180_000;
const TAIL = 2000;

/** The app of one task; `label` tells its containers apart from other runs. */
export function createTaskApp(options: { worktree: string; specDir: string; label: string; saved?: PreviewService[] }, deps: TaskAppDeps) {
  const { worktree, specDir, label } = options;
  let running: Extract<TaskAppResult, { ok: true }> | undefined;
  const servers: string[] = [];
  const stops: Array<() => Promise<void>> = [];

  const stop = async () => {
    for (const name of servers.splice(0).reverse()) await deps.servers.stopServer(name).catch(() => false);
    for (const stopOne of stops.splice(0).reverse()) await stopOne().catch(() => {});
    running = undefined;
  };

  const start = async (): Promise<TaskAppResult> => {
    if (running) return { ...running, reused: true };
    try {
      const files = await deps.listFiles();
      const read = deps.read;
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
      const database = await startTestServices(images, { docker: deps.docker, label, network: network?.name });
      stops.push(database.stop);
      if (database.status === 'unavailable') {
        await stop();
        return { ok: false, reason: `The database could not start: ${database.reason ?? 'Docker did not answer'}` };
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
      const notices = [...others.failed.map((failure) => `${failure.name}: ${failure.reason}`), ...others.moved.map(composeMovedNotice)];
      const wiring = { planned: compose, started: others.started };
      const varsFor = (dir: string) => baseEnvVars({ dir, ...exampleTexts(files, read, dir), started: database.started, compose: wiring, recipe: recipe.env });

      // Libraries first, then the recipe's migrations and seed: only on this fresh database
      const ownDatabase = database.started.some((service) => service.kind === 'postgres' || service.kind === 'mysql');
      const build = recipe.steps?.build ?? workspaceLibraries({ files, read }, services).map((library) => ({ dir: library.dir, command: library.command }));
      const install = files.includes('package.json') ? deps.installCommand() : null;
      const steps = [...(install ? [{ dir: '', command: install }] : []), ...build, ...(ownDatabase ? [...(recipe.steps?.migrate ?? []), ...(recipe.steps?.seed ?? [])] : [])];
      for (const step of steps) {
        const result = await deps.runCommand(step.command, resolve(worktree, step.dir), envOf(varsFor(step.dir)));
        if (result.code !== 0) {
          await stop();
          return { ok: false, reason: `${step.command} failed (exit ${result.code}):\n${result.output.slice(-TAIL)}` };
        }
      }

      const up = await startRecipeServices(
        {
          services,
          root: worktree,
          specDir,
          serverName: (service) => `app-${service.name}`,
          read,
          baseVars: varsFor,
          timeoutMs: SERVER_TIMEOUT_MS,
          check: () => {},
          onServer: (name) => servers.push(name),
        },
        deps.servers,
      );
      running = {
        ok: true,
        url: up.url,
        reused: false,
        services: up.ordered.map((service) => `${service.name} at http://localhost:${up.ports[service.name]}`),
        ...(ownDatabase ? { database: database.started.map((service) => service.kind).join(', ') } : {}),
        ...(notices.length ? { notices } : {}),
      };
      return running;
    } catch (error) {
      const { message, logTail = '' } = error as Error & { logTail?: string };
      await stop();
      return { ok: false, reason: `${message}${logTail ? `\n${logTail.slice(-TAIL)}` : ''}` };
    }
  };

  return { start, stop };
}
