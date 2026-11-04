/**
 * Whether QA approved this exact code. The verdict in implementation_plan.json
 * is how a reviewer reports it, but agents can edit that file, and it stays there
 * as the code moves on. So a later run trusts only this record: written by the
 * app when a review ends in approval, outside the folders agents work in, and
 * tied to the state of the code. Anything else means a new review. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { writeFileReplacingSync } from '../safe-write';

export function qaApprovalsDir(): string {
  return join(homedir(), '.vibe-teamlead', 'qa-approvals');
}

function recordFile(dir: string, projectDir: string, specDir: string): string {
  const task = createHash('sha256').update(`${resolve(projectDir)}\0${basename(specDir)}`).digest('hex');
  return join(dir, `${task}.json`);
}

export function approvalHolds(dir: string, projectDir: string, specDir: string, fingerprint: string | undefined): boolean {
  if (!fingerprint) return false;
  try {
    const record = JSON.parse(readFileSync(recordFile(dir, projectDir, specDir), 'utf-8')) as { fingerprint?: unknown };
    return record.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

/** Never throws: without a record, a later run simply reviews again. */
export function recordApproval(dir: string, projectDir: string, specDir: string, fingerprint: string | undefined): void {
  if (!fingerprint) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileReplacingSync(recordFile(dir, projectDir, specDir), JSON.stringify({ fingerprint, at: new Date().toISOString() }));
  } catch {
    // informational
  }
}

export function clearApproval(dir: string, projectDir: string, specDir: string): void {
  try {
    rmSync(recordFile(dir, projectDir, specDir), { force: true });
  } catch {
    // A record left behind still needs the same code to count
  }
}

const NOT_THE_APP = ['--', '.', ':(exclude).vibe-teamlead'];

const MAX_HASHED_FILE = 64 * 1024 * 1024;

/** What a new file holds. A link counts as where it points; a huge file as its size and time. */
function newFileState(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return '';
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (!stat.isFile()) return '';
  if (stat.size > MAX_HASHED_FILE) return `large:${stat.size}:${stat.mtimeMs}`;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The state of the code: HEAD, uncommitted edits and new files. Undefined when git
 * can't say, or was told to skip a file, since then a diff can't show its edits.
 * Ignored files don't count: they never reach the task's commits.
 */
export async function workTreeFingerprint(cwd: string): Promise<string | undefined> {
  const git = (args: string[]) =>
    new Promise<string | undefined>((done) => {
      execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => done(error ? undefined : stdout));
    });
  const [head, diff, untracked, tracked] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', ...NOT_THE_APP]),
    git(['ls-files', '--others', '--exclude-standard', '-z', ...NOT_THE_APP]),
    git(['ls-files', '-v', '-z']),
  ]);
  if (head === undefined || diff === undefined || untracked === undefined || tracked === undefined) return undefined;
  // `ls-files -v`: S is skip-worktree, a lowercase tag is assume-unchanged
  if (tracked.split('\0').some((entry) => /^(S|[a-z]) /.test(entry))) return undefined;
  const hash = createHash('sha256').update(head).update('\0').update(diff).update('\0');
  for (const file of untracked.split('\0').filter(Boolean)) {
    hash.update(`${file}\0${newFileState(join(cwd, file))}\0`);
  }
  return hash.digest('hex');
}
