/**
 * Reading zip archives without /usr/bin/unzip, which Windows lacks: there the
 * bsdtar that ships with Windows 10+ (System32\tar.exe) lists and extracts zips.
 * Always the System32 one by full path, because Git for Windows puts its GNU
 * tar first on PATH and GNU tar cannot read a zip. macOS keeps unzip.
 */

import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

import { envValue } from './env';
import { getPlatformKey } from './index';

type PlatformKey = 'darwin' | 'win32' | 'linux';

export interface ZipTotals {
  bytes: number;
  files: number;
}

/** How to list and extract a zip on a platform. */
export interface ZipTool {
  bin: string;
  listArgs(archive: string): string[];
  extractArgs(archive: string, dest: string): string[];
  /** Totals from the list output; null when it can't be read or an entry is unsafe */
  totals(listing: string): ZipTotals | null;
}

/** Windows' own bsdtar. */
export function windowsTar(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'tar.exe');
}

/** Totals from the last non-empty line of `unzip -l` output; null if it is not a summary. */
export function parseZipTotals(listing: string): ZipTotals | null {
  const lines = listing.split('\n').filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1] ?? '';
  const m = /^\s*(\d+)\s+(\d+)\s+files?\s*$/.exec(last);
  return m ? { bytes: Number(m[1]), files: Number(m[2]) } : null;
}

// mode, links, owner, group, size, three date tokens (locale order varies), then the name
const TAR_LINE = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s(.+)$/;

/** An entry name that would land outside the extraction folder (zip-slip). */
function unsafeName(name: string): boolean {
  return /^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..');
}

/**
 * Totals from `tar -tvf` (bsdtar) output: the sizes of the files (folders don't count).
 * Null when a line can't be read or an entry would land outside the folder.
 */
export function parseTarListing(listing: string): ZipTotals | null {
  let bytes = 0;
  let files = 0;
  for (const raw of listing.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const m = TAR_LINE.exec(raw);
    if (!m || unsafeName(m[3])) return null;
    if (m[1] === 'd') continue;
    bytes += Number(m[2]);
    files += 1;
  }
  return { bytes, files };
}

export function zipTool(platform: PlatformKey = getPlatformKey(), env: NodeJS.ProcessEnv = process.env): ZipTool {
  if (platform === 'win32') {
    return {
      bin: windowsTar(env),
      listArgs: (archive) => ['-tvf', archive],
      extractArgs: (archive, dest) => ['-xf', archive, '-C', dest],
      totals: parseTarListing,
    };
  }
  return {
    bin: '/usr/bin/unzip',
    // -P '': never prompt for a password
    listArgs: (archive) => ['-l', '-P', '', archive],
    extractArgs: (archive, dest) => ['-qq', '-o', '-P', '', archive, '-d', dest],
    totals: parseZipTotals,
  };
}

/**
 * One entry of a zip as UTF-8 text (`tar -xOf`), e.g. word/document.xml of a .docx.
 * Null when the file is not a zip, the entry is missing, or tar fails.
 */
export function readZipEntry(
  archive: string,
  entry: string,
  opts: { tar?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    // Bytes, decoded once at the end: a multi-byte character may straddle two output chunks
    const child = execFile(
      opts.tar ?? windowsTar(),
      ['-xOf', archive, entry],
      { encoding: 'buffer', timeout: opts.timeoutMs ?? 30_000, maxBuffer: opts.maxBytes ?? 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.toString('utf8')),
    );
    child.stdin?.end();
  });
}
