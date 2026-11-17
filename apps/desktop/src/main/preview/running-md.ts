/**
 * RUNNING.md: how to run the project, at its root, kept up to date by the agents. The
 * Preview shows it when it can't run the project itself. The file is agent-written, so
 * it is read only from inside the project (a link leading out of it counts as missing)
 * and only up to a cap.
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const RUNNING_MD = 'RUNNING.md';
export const RUNNING_MD_MAX_BYTES = 256 * 1024;

export type RunningMd = { exists: false } | { exists: true; markdown: string; truncated: boolean };

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export function readRunningMd(projectRoot: string): RunningMd {
  try {
    const root = realpathSync(projectRoot);
    const file = realpathSync(path.join(root, RUNNING_MD));
    if (!inside(root, file)) return { exists: false };
    const stats = statSync(file);
    if (!stats.isFile()) return { exists: false };
    const { size } = stats;
    const length = Math.min(size, RUNNING_MD_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    return { exists: true, markdown: buffer.toString('utf-8'), truncated: size > RUNNING_MD_MAX_BYTES };
  } catch {
    return { exists: false };
  }
}
