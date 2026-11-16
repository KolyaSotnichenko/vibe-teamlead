/**
 * The host's tar when it is bsdtar (macOS, Windows), which reads zips; null elsewhere.
 * Linux CI has GNU tar, which can't: tests of the Windows zip path run where bsdtar is.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function detect(): string | null {
  // Windows' own bsdtar first: Git for Windows may put its GNU tar on PATH
  const system = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\tar.exe` : undefined;
  for (const tar of [system, '/usr/bin/tar', 'tar'].filter((t): t is string => !!t)) {
    try {
      if (/bsdtar/i.test(execFileSync(tar, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))) return tar;
    } catch {
      // not there
    }
  }
  return null;
}

export const HOST_BSDTAR = detect();

const INFO_ZIP = '/usr/bin/zip';

/** Info-ZIP's zip(1): on macOS and Linux, not on Windows. */
export const HAS_INFO_ZIP = existsSync(INFO_ZIP);

/** Zip `entries` (paths relative to `cwd`, folders with their contents) with zip(1), or with bsdtar where there is no zip(1) (Windows). */
export function makeZip(zip: string, entries: string[], cwd: string): void {
  if (HAS_INFO_ZIP) execFileSync(INFO_ZIP, ['-qr', zip, ...entries], { cwd });
  else if (HOST_BSDTAR) execFileSync(HOST_BSDTAR, ['--format', 'zip', '-cf', zip, ...entries], { cwd });
  else throw new Error('No zip(1) or bsdtar on this machine to make a test zip');
}
