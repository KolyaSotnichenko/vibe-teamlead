/**
 * What the project knows about its imported design package: where it lives, which
 * components it holds, and which of them the project has already built. Kept in the app's
 * folder of the project, next to the system meta.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { DesignPackageInfo, DesignSystemInfo } from '../../../../shared/types';
import { writeFileReplacingSync } from '../../safe-write';

export const PACKAGE_DIR = '.vibe-teamlead/design/package';

/** The package meta file, relative to the project. */
export const PACKAGE_META_FILE = '.vibe-teamlead/design/package-meta.json';

const metaFile = (projectPath: string) => path.join(projectPath, ...PACKAGE_META_FILE.split('/'));

const COMPONENT_ROOTS = ['apps/web/src/components', 'src/components', 'components', 'app/components'];

/** Where rebuilt components go: the project's components folder plus the package namespace. */
export function componentsDirFor(projectPath: string, namespace: string): string {
  const isDir = (rel: string) => {
    try {
      return statSync(path.join(projectPath, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const root = COMPONENT_ROOTS.find(isDir) ?? 'src/components';
  return `${root}/${namespace.toLowerCase()}`;
}

export function writePackageMeta(projectPath: string, info: DesignPackageInfo): void {
  mkdirSync(path.dirname(metaFile(projectPath)), { recursive: true });
  writeFileReplacingSync(metaFile(projectPath), `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
}

export const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const NAMESPACE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const TEXT_MAX = 200;

/** A package namespace safe to put in paths and prompts; 'ds' when it is not a plain identifier. */
export function safeNamespace(value: unknown): string {
  return typeof value === 'string' && NAMESPACE.test(value) ? value : 'ds';
}

/** Package text (name, licence line) as one clean line: no control characters, no tags, capped. */
export function cleanPackageText(value: string): string {
  return value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203a')
    .slice(0, TEXT_MAX)
    .trim();
}

/** A relative path that stays inside the project: no absolute path, no `..` segment. */
function safeRelative(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).includes('..');
}

const underDir = (value: unknown, dir: string): value is string =>
  safeRelative(value) && (value === dir || value.startsWith(`${dir}/`));

/**
 * One folder or file name of a package path: letters and digits of any script (a Ukrainian
 * package names its folders in Cyrillic; macOS gives names decomposed, hence the marks), space
 * and . _ @ ( ) + -. No newlines, backticks, control characters or slashes: it is safe in prompts.
 */
const PATH_SEGMENT = /^[\p{L}\p{N}\p{M} ._@()+-]{1,64}$/u;

/** A path whose every segment is a plain name (no newlines, backticks, `.` or `..`). */
export function isPlainPackagePath(value: string): boolean {
  return value.split('/').every((s) => PATH_SEGMENT.test(s) && s !== '.' && s !== '..');
}

const packagePath = (value: unknown, dir: string): value is string => underDir(value, dir) && isPlainPackagePath(value);

export function readPackageMeta(projectPath: string): DesignPackageInfo | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(metaFile(projectPath), 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const { name, namespace, importedAt, dir, componentsDir } = raw;
  if (typeof name !== 'string' || typeof namespace !== 'string' || typeof importedAt !== 'string') return undefined;
  if (!packagePath(dir, PACKAGE_DIR) || !safeRelative(componentsDir)) return undefined;
  // These paths reach every builder prompt: one that is not plain makes the whole meta untrusted
  for (const value of [raw.componentCss, raw.componentTypes, raw.tokensCss]) {
    if (underDir(value, dir) && !isPlainPackagePath(value)) return undefined;
  }
  const packageFile = (value: unknown) => (packagePath(value, dir) ? value : undefined);
  const files = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => packagePath(v, dir)) : []);
  const components = (Array.isArray(raw.components) ? raw.components : []).flatMap((c: unknown) => {
    const entry = c as { name?: unknown; readme?: unknown } | null;
    if (!entry || typeof entry.name !== 'string' || !COMPONENT_NAME.test(entry.name)) return [];
    const readme = packageFile(entry.readme);
    return [{ name: entry.name, ...(readme ? { readme } : {}) }];
  });
  const componentCss = packageFile(raw.componentCss);
  const componentTypes = packageFile(raw.componentTypes);
  const tokensCss = packageFile(raw.tokensCss);
  const built = Array.isArray(raw.built) ? raw.built.filter((v): v is string => typeof v === 'string' && COMPONENT_NAME.test(v)) : undefined;
  return {
    name: cleanPackageText(name),
    namespace: safeNamespace(namespace),
    importedAt,
    dir,
    componentsDir,
    components,
    ...(componentCss ? { componentCss } : {}),
    ...(componentTypes ? { componentTypes } : {}),
    ...(tokensCss ? { tokensCss } : {}),
    logos: files(raw.logos),
    fonts: files(raw.fonts),
    ...(typeof raw.licenceLine === 'string' && cleanPackageText(raw.licenceLine) ? { licenceLine: cleanPackageText(raw.licenceLine) } : {}),
    // Light and dark only when the package has dark colours (an old or edited meta says so)
    themes: raw.themes === 'light-dark' && raw.hasDark === true ? 'light-dark' : 'light',
    hasDark: raw.hasDark === true,
    ...(safeRelative(raw.systemPath) ? { systemPath: raw.systemPath } : {}),
    ...(built ? { built } : {}),
  };
}

/** The components whose folder already exists under the components folder. */
export function builtComponents(cwd: string, componentsDir: string, names: string[]): string[] {
  return names.filter((name) => COMPONENT_NAME.test(name) && existsSync(path.join(cwd, componentsDir, name)));
}

/**
 * The design system for one task: a copy whose package lists the components already built in
 * `cwd` (the task's worktree). The shared info is never changed.
 */
export function withBuiltComponents(info: DesignSystemInfo, cwd: string): DesignSystemInfo {
  if (!info.package) return info;
  const pkg = info.package;
  return { ...info, package: { ...pkg, built: builtComponents(cwd, pkg.componentsDir, pkg.components.map((c) => c.name)) } };
}
