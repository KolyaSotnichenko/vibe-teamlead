/**
 * Writes into folders agents can reach (the spec directory first of all). An agent
 * can leave a link at any path there, and a plain write, or a temp file with a
 * predictable name, would then land wherever the link points, with the app's
 * rights. So the data goes to a new file with a random name, which a link can't
 * be waiting at, and that file is renamed into place. No Electron imports.
 */

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const NEW_FILE_ONLY = { encoding: 'utf-8', flag: 'wx' } as const;

const temporaryFor = (file: string) => join(dirname(file), `.${randomBytes(8).toString('hex')}.${basename(file)}`);

export async function writeFileReplacing(file: string, data: string, _encoding?: 'utf-8' | 'utf8'): Promise<void> {
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
  const temporary = temporaryFor(file);
  try {
    writeFileSync(temporary, data, NEW_FILE_ONLY);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
