/**
 * What the Preview proposes to run on first open: packages whose `dev` script
 * runs a frontend tool become the page (the first one) or more frontends, and
 * other packages with a `dev` or `start:dev` script become backends. The owner
 * confirms or edits the list once. Pure: no Electron imports, no file access.
 */

import type { PreviewService } from '../../shared/types/project';
import type { ProjectFiles } from '../ai/verification/detect-checks';

/** First word of a `dev` script that marks a frontend dev server */
const FRONTEND_TOOLS = new Set(['next', 'vite', 'nuxt', 'nuxi', 'svelte-kit', 'astro', 'ng', 'remix', 'react-scripts', 'react-router']);
const SKIPPED = /(^|\/)(node_modules|\.vibe-teamlead|\.git|dist|build)\//;
/** A root script that starts the workspace's packages, which are proposed on their own */
const RUNS_WORKSPACE = /^\s*(turbo|nx|lerna|concurrently|npm-run-all|run-p|(pnpm|yarn|bun|npm)\s+(-r|--recursive|-w|--workspaces?|--filter|workspaces))\b/;

type Manager = 'pnpm' | 'yarn' | 'bun' | 'npm';

function managerOf(files: string[]): Manager {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun';
  return 'npm';
}

function scriptsOf(text: string | null): Record<string, string> {
  try {
    const scripts = (JSON.parse(text ?? '') as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const isFrontend = (script: string | undefined) => !!script && FRONTEND_TOOLS.has(script.trim().split(/\s+/)[0] ?? '');

/** npm needs `--` to pass flags to the script; pnpm, yarn and bun pass them as they are. */
const withPort = (manager: Manager, script: string) => `${manager} run ${script}${manager === 'npm' ? ' -- --port {port}' : ' --port {port}'}`;

export function proposePreviewServices({ files, read }: ProjectFiles): PreviewService[] {
  const manager = managerOf(files);
  const packages = files
    .filter((file) => (file === 'package.json' || file.endsWith('/package.json')) && !SKIPPED.test(file))
    .sort();
  const services: PreviewService[] = [];
  let pageChosen = false;
  for (const file of packages) {
    const dir = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
    const scripts = scriptsOf(read(file));
    const name = dir ? dir.split('/').pop()!.replace(/[^\w-]/g, '-').slice(0, 40) : 'web';
    if (isFrontend(scripts.dev)) {
      services.push({ name, dir, command: withPort(manager, 'dev'), ...(pageChosen ? {} : { page: true }) });
      pageChosen = true;
    } else if ((scripts['start:dev'] || scripts.dev) && !(!dir && packages.length > 1 && RUNS_WORKSPACE.test(scripts.dev ?? ''))) {
      services.push({ name, dir, command: `${manager} run ${scripts['start:dev'] ? 'start:dev' : 'dev'}` });
    }
  }
  return services;
}

export interface WorkspaceLibrary {
  name: string;
  dir: string;
  command: string;
}

interface WorkspacePackage {
  name: string;
  dir: string;
  json: Record<string, unknown>;
}

/** Whether a package is used from its built output (dist/, build/, lib/), which a fresh checkout doesn't have. */
function usesBuiltOutput(json: Record<string, unknown>): boolean {
  const entries: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') entries.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v);
  };
  collect(json.main);
  collect(json.types);
  collect(json.typings);
  collect(json.module);
  collect(json.exports);
  return entries.some((entry) => /(^|\/)(dist|build|lib|out)\//.test(entry.replace(/^\.\//, '')));
}

const workspaceDeps = (json: Record<string, unknown>): string[] =>
  ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) =>
    Object.entries((json[field] as Record<string, string> | undefined) ?? {})
      .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
      .map(([name]) => name),
  );

/**
 * The workspace packages the services use that run from built output, in build
 * order (a library's own workspace libraries first). A fresh worktree has no
 * dist/ for them, and the services fail without it. Pure.
 */
export function workspaceLibraries({ files, read }: ProjectFiles, services: PreviewService[]): WorkspaceLibrary[] {
  const manager = managerOf(files);
  const byName = new Map<string, WorkspacePackage>();
  const byDir = new Map<string, WorkspacePackage>();
  for (const file of files) {
    if (!(file === 'package.json' || file.endsWith('/package.json')) || SKIPPED.test(file)) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(read(file) ?? '') as Record<string, unknown>;
    } catch {
      continue;
    }
    const dir = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
    const pkg = { name: typeof json.name === 'string' ? json.name : dir, dir, json };
    byDir.set(dir, pkg);
    if (typeof json.name === 'string') byName.set(json.name, pkg);
  }

  const ordered: WorkspaceLibrary[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = byName.get(name);
    if (!pkg) return;
    for (const dep of workspaceDeps(pkg.json)) visit(dep);
    const scripts = (pkg.json.scripts as Record<string, string> | undefined) ?? {};
    if (scripts.build && usesBuiltOutput(pkg.json)) ordered.push({ name: pkg.name, dir: pkg.dir, command: `${manager} run build` });
  };
  for (const service of services) {
    const pkg = byDir.get(service.dir);
    if (pkg) for (const dep of workspaceDeps(pkg.json)) visit(dep);
  }
  return ordered;
}
