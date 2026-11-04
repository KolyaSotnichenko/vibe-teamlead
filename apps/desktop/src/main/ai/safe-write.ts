/**
 * Writes into folders agents can reach (the spec directory first of all). An agent
 * can leave a link at any path there, and a plain write, or a temp file with a
 * predictable name, would then land wherever the link points, with the app's
 * rights. So the data goes to a new file with a random name, which a link can't
 * be waiting at, and that file is renamed into place. A link in place of a folder
 * on the way there is refused: from the app's folder down, no link belongs. No
 * Electron imports.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

const NEW_FILE_ONLY = { encoding: 'utf-8', flag: 'wx' } as const;

const temporaryFor = (file: string) => join(dirname(file), `.${randomBytes(8).toString('hex')}.${basename(file)}`);

const APP_FOLDER = '.vibe-teamlead';

function refuseLinkOnTheWay(file: string): void {
  const parts = dirname(file).split(sep);
  const start = parts.lastIndexOf(APP_FOLDER);
  if (start === -1) return;
  for (let i = start; i < parts.length; i++) {
    const folder = parts.slice(0, i + 1).join(sep);
    if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing to write through a link: ${folder}`);
    }
  }
}

export async function writeFileReplacing(file: string, data: string, _encoding?: 'utf-8' | 'utf8'): Promise<void> {
  refuseLinkOnTheWay(file);
  const temporary = temporaryFor(file);
  try {
    await writeFile(temporary, data, NEW_FILE_ONLY);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function writeFileReplacingSync(file: string, data: string, _encoding?: 'utf-8' | 'utf8'): void {
  refuseLinkOnTheWay(file);
  const temporary = temporaryFor(file);
  try {
    writeFileSync(temporary, data, NEW_FILE_ONLY);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
