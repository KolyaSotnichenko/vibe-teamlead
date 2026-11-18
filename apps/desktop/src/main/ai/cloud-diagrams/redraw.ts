/**
 * The reality moment: after a merge that changed Terraform, the app redraws the
 * project's cloud architecture from the code itself, without a model. Like the app
 * checks (verify-task.ts) it runs on a clean copy of what is committed, with a short
 * environment: no keys, no cloud logins (cloudSafeEnv). Terraform still downloads
 * its providers and modules (`terraform init`), and nothing else.
 *
 * TerraVision runs Terraform once (`graphdata`, plus `visualise` for the HTML page);
 * the SVG and draw.io pictures are drawn from the graph it saved. TerraVision has no
 * static mode: drawing from a folder always runs `terraform init` and `plan`
 * (never `apply`), so the code is checked first (terraform-safety.ts) and refused
 * when it could run programs or fetch code from elsewhere. A failure or
 * missing tools is a quiet note in meta.json, never an error: the last drawing stays.
 * No Electron: testable with fakes.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import type { RunOptions, RunResult } from '../../platform/exec';
import { localProviderPath, providerInstallationConfig, terraformUnsafe, walkTerraformFiles } from './terraform-safety';
import { cloudSafeEnv, type CloudTool, type CloudToolsReadiness, terravisionCommand } from './terravision';

/** refused: the static check found code that could run programs or fetch it from elsewhere (terraform-safety.ts) */
export type CloudDrawStatus = 'drawn' | 'unavailable' | 'needs_cloud_access' | 'refused' | 'failed';

export interface CloudDrawing {
  commit: string;
  taskId?: string;
  taskTitle?: string;
  drawnAt: string;
  /** The Terraform folder it was drawn from, relative to the repository */
  source: string;
  /** File names in <store>/latest */
  files: { svg?: string; drawio?: string; html?: string; graph?: string };
}

export interface CloudArchitectureMeta {
  /** The latest successful drawing */
  drawn?: CloudDrawing;
  lastAttempt?: { at: string; commit: string; status: CloudDrawStatus; detail?: string; missing?: CloudTool[] };
}

export interface RedrawDeps {
  git: (args: string[], cwd?: string) => Promise<{ ok: boolean; stdout: string; raw: string; output: string }>;
  run: (file: string, args: string[], options: RunOptions) => Promise<RunResult>;
  tools: CloudToolsReadiness;
  platform: 'darwin' | 'win32' | 'linux';
  hostEnv: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Per TerraVision step (default 10 minutes: init downloads providers) */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const STEP_TIMEOUT_MS = 10 * 60_000;
const META = 'meta.json';
const TAIL = 600;
const MAX_FILES = 1000;

export function terraformChanged(files: string[]): boolean {
  return files.some((file) => /\.((tf|tofu)(\.json)?|tfvars)$/i.test(file));
}

const isModule = (dir: string) => dir.split(/[\\/]/).includes('modules');
const depth = (dir: string) => (dir === '.' ? 0 : dir.split(/[\\/]/).length);

/** The folder to draw: one a changed file is in (not a reusable module), else the shallowest root. Pure. */
export function terraformRoot(tfFiles: string[], changedFiles: string[]): string | undefined {
  // Either separator in, the platform's out
  const native = (path: string) => path.split(/[\\/]/).join(sep);
  const dirs = [...new Set(tfFiles.map((file) => dirname(native(file))))];
  if (!dirs.length) return undefined;
  const changedDirs = new Set(changedFiles.filter((f) => /\.((tf|tofu)(\.json)?|tfvars)$/i.test(f)).map((f) => dirname(native(f))));
  const roots = dirs.filter((dir) => !isModule(dir));
  const pool = roots.length ? roots : dirs;
  const changed = pool.filter((dir) => changedDirs.has(dir));
  return (changed.length ? changed : pool).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
}

const CREDENTIALS = /(no valid credential|could not find default credentials|unable to locate credentials|az login|authenticat|credentials|access denied|unauthori[sz]ed|forbidden|InvalidClientTokenId|ExpiredToken)/i;

export function classifyFailure(output: string): 'needs_cloud_access' | 'failed' {
  return CREDENTIALS.test(output) ? 'needs_cloud_access' : 'failed';
}

export function readCloudArchitecture(storeDir: string): CloudArchitectureMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(storeDir, META), 'utf-8')) as CloudArchitectureMeta;
  } catch {
    return undefined;
  }
}

function writeMeta(storeDir: string, meta: CloudArchitectureMeta): CloudArchitectureMeta {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, META), JSON.stringify(meta, null, 2));
  return meta;
}

const tail = (result: RunResult) => `${result.stderr}\n${result.stdout}`.trim().slice(-TAIL);

/** Redraw after a merge. Undefined when the merge changed no Terraform (nothing is written then). Never throws. */
export async function redrawCloudArchitecture(
  input: { projectDir: string; commit: string; changedFiles: string[]; storeDir: string; taskId?: string; taskTitle?: string },
  deps: RedrawDeps,
): Promise<CloudArchitectureMeta | undefined> {
  const { projectDir, commit, changedFiles, storeDir } = input;
  if (!terraformChanged(changedFiles)) return undefined;
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const previous = readCloudArchitecture(storeDir) ?? {};
  const attempt = (status: CloudDrawStatus, extra: { detail?: string; missing?: CloudTool[] } = {}) =>
    writeMeta(storeDir, { ...previous, lastAttempt: { at: now(), commit, status, ...extra } });

  const command = terravisionCommand(deps.tools, false);
  if (!command || !deps.tools.drawFromCode) return attempt('unavailable', { missing: deps.tools.missing });

  let parent: string | undefined;
  try {
    parent = mkdtempSync(join(tmpdir(), 'vibe-teamlead-cloud-'));
    const copy = join(parent, 'copy');
    const out = join(parent, 'out');
    const home = join(parent, 'home');
    mkdirSync(out);
    mkdirSync(home);
    const cloned = await deps.git(['clone', '-q', '--no-hardlinks', '--no-checkout', projectDir, copy]);
    if (!cloned.ok) return attempt('failed', { detail: cloned.output.slice(-TAIL) });
    const checkedOut = await deps.git(['checkout', '-q', '--detach', commit], copy);
    if (!checkedOut.ok) return attempt('failed', { detail: checkedOut.output.slice(-TAIL) });

    // Every Terraform file of the commit is checked before anything runs Terraform on it
    let allFiles: string[];
    try {
      allFiles = walkTerraformFiles(copy);
    } catch (error) {
      return attempt('refused', { detail: `Couldn't draw from code safely: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (allFiles.length > MAX_FILES) return attempt('refused', { detail: `Couldn't draw from code safely: more than ${MAX_FILES} Terraform files to check.` });
    const unsafe = terraformUnsafe(allFiles.map((path) => ({ path, text: readFileSync(join(copy, path), 'utf-8') })));
    if (unsafe) return attempt('refused', { detail: `Couldn't draw from code safely: ${unsafe}` });
    const ownProviders = localProviderPath(copy);
    if (ownProviders) return attempt('refused', { detail: `Couldn't draw from code safely: ${ownProviders} brings its own providers or Terraform settings` });
    const root = terraformRoot(allFiles.filter((file) => /\.(tf|tofu)$/i.test(file)).map((file) => file.split('/').join(sep)), changedFiles);
    if (!root) return attempt('failed', { detail: 'No Terraform files in the merged commit.' });
    const source = root === '.' ? copy : join(copy, root);

    const env = cloudSafeEnv(deps.hostEnv, { platform: deps.platform, sandboxHome: home });
    if (env.TF_PLUGIN_CACHE_DIR) mkdirSync(env.TF_PLUGIN_CACHE_DIR, { recursive: true });
    // Only the vetted providers can be installed, whatever the code asks for
    if (!env.TF_CLI_CONFIG_FILE) return attempt('refused', { detail: "Couldn't draw from code safely: no Terraform settings file to limit providers" });
    mkdirSync(dirname(env.TF_CLI_CONFIG_FILE), { recursive: true });
    writeFileSync(env.TF_CLI_CONFIG_FILE, providerInstallationConfig(), { mode: 0o600 });
    const engine = deps.tools.engine ? ['--engine', deps.tools.engine] : [];
    const step = (args: string[]) =>
      deps.run(command.file, [...command.args, ...args], { cwd: out, env, timeoutMs: deps.timeoutMs ?? STEP_TIMEOUT_MS, killGroup: true, signal: deps.signal, maxOutput: 256 * 1024 });

    const graph = await step(['graphdata', '--source', source, '--outfile', 'architecture', ...engine]);
    if (graph.code !== 0) {
      const detail = graph.timedOut ? 'TerraVision took too long.' : tail(graph);
      return attempt(graph.timedOut ? 'failed' : classifyFailure(detail), { detail });
    }
    const graphFile = join(out, 'architecture.tvg.json');
    await step(['draw', '--source', graphFile, '--format', 'svg', '--outfile', 'architecture']);
    await step(['draw', '--source', graphFile, '--format', 'drawio', '--outfile', 'architecture']);
    // The interactive page needs the Terraform data, not the graph: one more plan, and optional
    await step(['visualise', '--source', source, '--outfile', 'architecture', ...engine]);

    const produced = readdirSync(out);
    const pick = (pattern: RegExp) => produced.find((name) => pattern.test(name));
    const files = {
      svg: pick(/\.svg$/i),
      drawio: pick(/\.drawio$/i),
      html: pick(/\.html$/i),
      graph: pick(/\.tvg\.json$/i),
    };
    if (!files.svg && !files.drawio) return attempt('failed', { detail: 'TerraVision made no diagram.' });

    const latest = join(storeDir, 'latest');
    rmSync(latest, { recursive: true, force: true });
    mkdirSync(latest, { recursive: true });
    const kept: CloudDrawing['files'] = {};
    for (const [kind, name] of Object.entries(files) as [keyof CloudDrawing['files'], string | undefined][]) {
      if (!name) continue;
      copyFileSync(join(out, name), join(latest, name));
      kept[kind] = name;
    }
    const at = now();
    return writeMeta(storeDir, {
      drawn: {
        commit,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.taskTitle ? { taskTitle: input.taskTitle } : {}),
        drawnAt: at,
        source: root,
        files: kept,
      },
      lastAttempt: { at, commit, status: 'drawn' },
    });
  } catch (error) {
    try {
      return attempt('failed', { detail: error instanceof Error ? error.message : String(error) });
    } catch {
      return undefined;
    }
  } finally {
    if (parent) rmSync(parent, { recursive: true, force: true });
  }
}
