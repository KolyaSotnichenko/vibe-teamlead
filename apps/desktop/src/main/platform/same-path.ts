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
