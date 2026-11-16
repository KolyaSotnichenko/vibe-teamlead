/**
 * The host's tar when it is bsdtar (macOS, Windows), which reads zips; null elsewhere.
 * Linux CI has GNU tar, which can't: tests of the Windows zip path run where bsdtar is.
 */
import { execFileSync } from 'node:child_process';

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
