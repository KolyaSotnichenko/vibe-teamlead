/**
 * Importing a designer's design-system package into a project (no Electron: the IPC
 * handlers only wire these up).
 *
 * Inspect unpacks the chosen zip or folder into `package-staging/` and summarises it.
 * Import moves staging to `package/` (replacing the previous package), takes the exact
 * tokens, has the design agent write the system, saves it, and records what the package
 * holds. A failed or cancelled import puts everything back as it was, with staging kept
 * for a retry. Nothing from the package is executed.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { DesignPackageInfo, DesignPackageSummary, DesignThemes } from '../../../../shared/types';
import type { writeFromPackage } from '../design-agent';
import { DesignTokensSchema, resolveDesignSystemPaths, saveDesignSystem } from '../design-system';
import { readReferences } from '../references';
import { recordSystemMeta } from '../system-meta';
import {
  COMPONENT_NAME,
  PACKAGE_DIR,
  PACKAGE_META_FILE,
  cleanPackageText,
  componentsDirFor,
  isPlainPackagePath,
  readPackageMeta,
  safeNamespace,
  writePackageMeta,
} from './package-meta';
import { packageTokens } from './package-tokens';
import { type DesignPackage, readDesignPackage } from './read-package';
import { unpackDesignPackage } from './unpack';

export type DesignSettings = Parameters<typeof resolveDesignSystemPaths>[1];

export const STAGING_DIR = '.vibe-teamlead/design/package-staging';
const PREVIOUS_DIR = '.vibe-teamlead/design/package-previous';
const PREVIOUS_META = '.vibe-teamlead/design/package-meta.previous.json';

const DARK_PREFIX = 'dark/';

const abs = (projectPath: string, rel: string) => path.join(projectPath, ...rel.split('/'));

const ROOT_NAME_ERROR =
  "The package's top folder name can use only Latin letters, digits, spaces and . _ - @ ( ) + (at most 64 characters). Rename the folder and choose the package again.";

/** Unpacks `source` into a clean staging folder and says what the package holds. */
export async function inspectDesignPackage(
  projectPath: string,
  settings: DesignSettings,
  source: string,
): Promise<DesignPackageSummary> {
  const staging = abs(projectPath, STAGING_DIR);
  await rm(staging, { recursive: true, force: true });
  const { skipped } = await unpackDesignPackage(source, staging);
  const pkg = readDesignPackage(staging);
  // The top folder is part of every path the builders are given
  if (pkg.root && !isPlainPackagePath(pkg.root)) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(ROOT_NAME_ERROR);
  }
  const tokens = packageTokens(staging, pkg, 'light-dark');
  const dark = tokens?.colors.filter((c) => c.name.startsWith(DARK_PREFIX)).length ?? 0;
  const system = resolveDesignSystemPaths(projectPath, settings);
  const licenceLine = pkg.licenceLine ? cleanPackageText(pkg.licenceLine) : '';
  return {
    name: cleanPackageText(pkg.name),
    components: pkg.components.map((c) => c.name),
    logos: pkg.logos.length,
    fonts: pkg.fonts.length,
    colors: { light: (tokens?.colors.length ?? 0) - dark, dark },
    hasTokens: tokens !== undefined,
    ...(licenceLine ? { licenceLine } : {}),
    ...(system.exists ? { replaces: system.markdownPath } : {}),
    skipped,
  };
}

export interface ImportDeps {
  write: typeof writeFromPackage;
  addReferences: (files: string[]) => Promise<unknown>;
  /** The project's references by file name and size (default: read from the references index) */
  existingReferences?: () => Array<{ name: string; size: number }>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** Moves `from` to `to` when it exists, replacing `to`. */
async function moveIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await rm(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  await rename(from, to);
}

/** Imports the inspected package from staging. */
export async function importDesignPackage(
  projectPath: string,
  settings: DesignSettings,
  opts: { themes: DesignThemes },
  deps: ImportDeps,
): Promise<void> {
  const staging = abs(projectPath, STAGING_DIR);
  if (!existsSync(staging)) throw new Error('There is no design package to import. Choose the package again.');
  deps.signal?.throwIfAborted();

  const pkgDir = abs(projectPath, PACKAGE_DIR);
  const metaFile = abs(projectPath, PACKAGE_META_FILE);
  const previousDir = abs(projectPath, PREVIOUS_DIR);
  const previousMeta = abs(projectPath, PREVIOUS_META);

  // Keep the previous package aside until the new one is in place
  await rm(previousDir, { recursive: true, force: true });
  rmSync(previousMeta, { force: true });
  await moveIfExists(pkgDir, previousDir);
  await moveIfExists(metaFile, previousMeta);

  let systemSaved = false;
  try {
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
    deps.signal?.throwIfAborted();
    // Invalid tokens must fail here, before saveDesignSystem has written the markdown
    DesignTokensSchema.parse(result.tokens);
    const info = packageInfo(projectPath, pkg, opts.themes);
    saveDesignSystem(projectPath, settings, result);
    systemSaved = true;
    writePackageMeta(projectPath, info);
    recordSystemMeta(projectPath, { how: 'package', packageName: info.name });
    const references = newReferences(pkgDir, pkg, deps.existingReferences ?? (() => referenceSizes(projectPath)));
    if (references.length) await deps.addReferences(references);
  } catch (error) {
    // Once the system is written the import has happened: the previous package is not restored
    if (!systemSaved) {
      rmSync(metaFile, { force: true });
      await moveIfExists(pkgDir, staging);
      await moveIfExists(previousDir, pkgDir);
      await moveIfExists(previousMeta, metaFile);
    }
    throw error;
  } finally {
    await rm(previousDir, { recursive: true, force: true });
    rmSync(previousMeta, { force: true });
  }
}

/** Drops the inspected package. */
export function cancelDesignPackage(projectPath: string): void {
  rmSync(abs(projectPath, STAGING_DIR), { recursive: true, force: true });
}

/** Recomputes the imported package's tokens for `themes`; no model is called. */
export function setDesignThemes(projectPath: string, settings: DesignSettings, themes: DesignThemes): void {
  const meta = readPackageMeta(projectPath);
  const pkgDir = abs(projectPath, PACKAGE_DIR);
  if (!meta || !existsSync(pkgDir)) throw new Error('There is no design package in this project.');
  const tokens = packageTokens(pkgDir, readDesignPackage(pkgDir), themes);
  if (!tokens) throw new Error("This package has no token files, so its themes can't be switched");
  saveDesignSystem(projectPath, settings, { tokens });
  writePackageMeta(projectPath, { ...meta, themes });
}

/** The project's references with the size of their stored file. */
function referenceSizes(projectPath: string): Array<{ name: string; size: number }> {
  return readReferences(projectPath).flatMap((ref) => {
    if (!ref.file) return [];
    try {
      return [{ name: ref.name, size: statSync(path.join(projectPath, ref.file)).size }];
    } catch {
      return [];
    }
  });
}

/** The package's extra images and PDFs that are not references yet (same name and size). */
function newReferences(pkgDir: string, pkg: DesignPackage, existing: () => Array<{ name: string; size: number }>): string[] {
  if (!pkg.extraReferences.length) return [];
  const known = existing();
  return pkg.extraReferences
    .map((p) => path.join(pkgDir, ...p.split('/')))
    .filter((file) => {
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        return false;
      }
      const name = path.basename(file);
      return !known.some((k) => k.name === name && k.size === size);
    });
}

/** What the package holds, with paths relative to the project and its text cleaned. */
function packageInfo(projectPath: string, pkg: DesignPackage, themes: DesignThemes): DesignPackageInfo {
  if (pkg.root && !isPlainPackagePath(pkg.root)) throw new Error(ROOT_NAME_ERROR);
  const rel = (p: string) => `${PACKAGE_DIR}/${p}`;
  // Only plain names reach the builders' prompts; anything else is left out of the meta
  const plain = (p: string | undefined) => (p && isPlainPackagePath(p) ? rel(p) : undefined);
  const namespace = safeNamespace(pkg.namespace);
  const licenceLine = pkg.licenceLine ? cleanPackageText(pkg.licenceLine) : '';
  return {
    name: cleanPackageText(pkg.name) || 'Design package',
    namespace,
    importedAt: new Date().toISOString(),
    dir: pkg.root ? rel(pkg.root) : PACKAGE_DIR,
    componentsDir: componentsDirFor(projectPath, namespace),
    components: pkg.components.filter((c) => COMPONENT_NAME.test(c.name)).map((c) => {
      const readme = plain(c.readme);
      return readme ? { name: c.name, readme } : { name: c.name };
    }),
    ...(plain(pkg.componentFiles.css) ? { componentCss: plain(pkg.componentFiles.css) } : {}),
    ...(plain(pkg.componentFiles.types) ? { componentTypes: plain(pkg.componentFiles.types) } : {}),
    ...(plain(pkg.tokenFiles.css) ? { tokensCss: plain(pkg.tokenFiles.css) } : {}),
    logos: pkg.logos.flatMap((p) => plain(p) ?? []),
    fonts: pkg.fonts.flatMap((p) => plain(p) ?? []),
    ...(licenceLine ? { licenceLine } : {}),
    themes,
  };
}
