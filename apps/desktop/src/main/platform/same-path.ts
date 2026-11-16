/**
 * Whether two paths name the same folder. Windows compares paths without
 * regard to case, git prints them with forward slashes, and Node may hold an
 * 8.3 short name (C:\Users\RUNNER~1\…, the usual TEMP of a long user name)
 * where git prints the long one; on Windows both sides are resolved, given
 * their long names by realpath, and lower-cased. Elsewhere the strings are
 * compared as given, as callers did before.
 */
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';

import { getPlatformKey } from './index';

export function samePath(
  a: string,
  b: string,
  platform: 'darwin' | 'win32' | 'linux' = getPlatformKey(),
  realpath: (path: string) => string = realpathSync.native,
): boolean {
  if (platform !== 'win32') return a === b;
  const comparable = (path: string) => {
    const absolute = win32.resolve(path);
    try {
      return win32.resolve(realpath(absolute)).toLowerCase();
    } catch {
      return absolute.toLowerCase();
    }
  };
  return comparable(a) === comparable(b);
}

/**
 * Whether `path` is `root` or inside it (a whole folder name, never `root-2`). On Windows case
 * and slash direction don't count (Docker and git may print either); the paths aren't resolved
 * on disk, since they may be gone. Elsewhere the strings are compared as given.
 */
export function isSameOrInside(
  path: string,
  root: string,
  platform: 'darwin' | 'win32' | 'linux' = getPlatformKey(),
): boolean {
  if (!path) return false;
  if (platform !== 'win32') return path === root || path.startsWith(`${root}/`);
  const norm = (p: string) => win32.resolve(p).replace(/\\+$/, '').toLowerCase();
  const a = norm(path);
  const b = norm(root);
  return a === b || a.startsWith(`${b}\\`);
}
