/**
 * Importing a designer's design-system package into a project (no Electron: the IPC
 * handlers only wire these up).
 *
 * Inspect unpacks the chosen zip or folder into `package-staging/` and summarises it.
 * Import moves staging to `package/` (replacing the previous package), takes the exact
 * tokens, has the design agent write the system, saves it, and records what the package
 * holds. Nothing from the package is executed.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { DesignPackageSummary, DesignThemes } from '../../../../shared/types';
import type { writeFromPackage } from '../design-agent';
import { resolveDesignSystemPaths, saveDesignSystem } from '../design-system';
import { recordSystemMeta } from '../system-meta';
import { PACKAGE_DIR, componentsDirFor, readPackageMeta, writePackageMeta } from './package-meta';
import { packageTokens } from './package-tokens';
import { type DesignPackage, readDesignPackage } from './read-package';
import { unpackDesignPackage } from './unpack';

export type DesignSettings = Parameters<typeof resolveDesignSystemPaths>[1];

export const STAGING_DIR = '.vibe-teamlead/design/package-staging';

const DARK_PREFIX = 'dark/';
const metaFile = '.vibe-teamlead/design/package-meta.json';

const stagingPath = (projectPath: string) => path.join(projectPath, STAGING_DIR);
const packagePath = (projectPath: string) => path.join(projectPath, PACKAGE_DIR);

/** Unpacks `source` into a clean staging folder and says what the package holds. */
export async function inspectDesignPackage(
  projectPath: string,
  settings: DesignSettings,
  source: string,
): Promise<DesignPackageSummary> {
  const staging = stagingPath(projectPath);
  await rm(staging, { recursive: true, force: true });
  const { skipped } = await unpackDesignPackage(source, staging);
  const pkg = readDesignPackage(staging);
  const tokens = packageTokens(staging, pkg, 'light-dark');
  const dark = tokens?.colors.filter((c) => c.name.startsWith(DARK_PREFIX)).length ?? 0;
  const system = resolveDesignSystemPaths(projectPath, settings);
  return {
    name: pkg.name,
    components: pkg.components.map((c) => c.name),
    logos: pkg.logos.length,
    fonts: pkg.fonts.length,
    colors: { light: (tokens?.colors.length ?? 0) - dark, dark },
    hasTokens: tokens !== undefined,
    ...(pkg.licenceLine ? { licenceLine: pkg.licenceLine } : {}),
    ...(system.exists ? { replaces: system.markdownPath } : {}),
    skipped,
  };
}

export interface ImportDeps {
  write: typeof writeFromPackage;
  addReferences: (files: string[]) => Promise<unknown>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** Imports the inspected package from staging. */
export async function importDesignPackage(
  projectPath: string,
  settings: DesignSettings,
  opts: { themes: DesignThemes },
  deps: ImportDeps,
): Promise<void> {
  const staging = stagingPath(projectPath);
  if (!existsSync(staging)) throw new Error('There is no design package to import. Choose the package again.');
  deps.signal?.throwIfAborted();

  // The previous package's meta would point at files that are about to go
  const pkgDir = packagePath(projectPath);
  rmSync(path.join(projectPath, metaFile), { force: true });
  await rm(pkgDir, { recursive: true, force: true });
  mkdirSync(path.dirname(pkgDir), { recursive: true });
  await rename(staging, pkgDir);

  const pkg = readDesignPackage(pkgDir);
  const tokens = packageTokens(pkgDir, pkg, opts.themes);
  const result = await deps.write({
    projectPath,
    pkgDir,
    pkg,
    tokens,
    signal: deps.signal,
    onProgress: deps.onProgress,
  });
  saveDesignSystem(projectPath, settings, result);
  writePackageMeta(projectPath, {
    ...packageInfo(projectPath, pkg),
    importedAt: new Date().toISOString(),
    themes: opts.themes,
  });
  recordSystemMeta(projectPath, { how: 'package', packageName: pkg.name });
  if (pkg.extraReferences.length) {
    await deps.addReferences(pkg.extraReferences.map((p) => path.join(pkgDir, ...p.split('/'))));
  }
}

/** Drops the inspected package. */
export function cancelDesignPackage(projectPath: string): void {
  rmSync(stagingPath(projectPath), { recursive: true, force: true });
}

/** Recomputes the imported package's tokens for `themes`; no model is called. */
export function setDesignThemes(projectPath: string, settings: DesignSettings, themes: DesignThemes): void {
  const meta = readPackageMeta(projectPath);
  const pkgDir = packagePath(projectPath);
  if (!meta || !existsSync(pkgDir)) throw new Error('There is no design package in this project.');
  const tokens = packageTokens(pkgDir, readDesignPackage(pkgDir), themes);
  if (tokens) saveDesignSystem(projectPath, settings, { tokens });
  writePackageMeta(projectPath, { ...meta, themes });
}

/** What the package holds, with paths relative to the project. */
function packageInfo(projectPath: string, pkg: DesignPackage) {
  const rel = (p: string) => `${PACKAGE_DIR}/${p}`;
  return {
    name: pkg.name,
    namespace: pkg.namespace,
    dir: pkg.root ? rel(pkg.root) : PACKAGE_DIR,
    componentsDir: componentsDirFor(projectPath, pkg.namespace),
    components: pkg.components.map((c) => (c.readme ? { name: c.name, readme: rel(c.readme) } : { name: c.name })),
    ...(pkg.componentFiles.css ? { componentCss: rel(pkg.componentFiles.css) } : {}),
    ...(pkg.componentFiles.types ? { componentTypes: rel(pkg.componentFiles.types) } : {}),
    ...(pkg.tokenFiles.css ? { tokensCss: rel(pkg.tokenFiles.css) } : {}),
    logos: pkg.logos.map(rel),
    fonts: pkg.fonts.map(rel),
    ...(pkg.licenceLine ? { licenceLine: pkg.licenceLine } : {}),
  };
}
