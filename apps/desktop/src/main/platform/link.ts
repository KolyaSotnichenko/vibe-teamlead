/**
 * Linking a project file or folder into a worktree (dependencies, .claude).
 *
 * macOS/Linux: a relative symlink, as before. Windows: a junction for a folder
 * (needs no admin rights or Developer Mode); a file symlink for a file, which
 * Windows refuses (EPERM) without Developer Mode, so a file is then copied.
 * A folder is never copied: it may be node_modules.
 */

import { copyFileSync, statSync, symlinkSync } from 'node:fs';
import { dirname, relative } from 'node:path';

import { getPlatformKey } from './index';

export interface LinkFs {
  symlinkSync: (target: string, path: string, type?: 'dir' | 'file' | 'junction') => void;
  copyFileSync: (src: string, dest: string) => void;
  statSync: (path: string) => { isDirectory(): boolean };
}

const nodeFs: LinkFs = { symlinkSync, copyFileSync, statSync };

const refused = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
};

/** How `target` now points at `source`. Throws when it could not be linked (or, for a file, copied). */
export function linkIntoWorktree(
  source: string,
  target: string,
  platform: 'darwin' | 'win32' | 'linux' = getPlatformKey(),
  fs: LinkFs = nodeFs,
): 'symlink' | 'junction' | 'copy' {
  const isDir = fs.statSync(source).isDirectory();
  if (platform === 'win32' && isDir) {
    fs.symlinkSync(source, target, 'junction');
    return 'junction';
  }
  try {
    if (platform === 'win32') fs.symlinkSync(source, target, 'file');
    else fs.symlinkSync(relative(dirname(target), source), target);
    return 'symlink';
  } catch (error) {
    if (isDir || !refused(error)) throw error;
    fs.copyFileSync(source, target);
    return 'copy';
  }
}
