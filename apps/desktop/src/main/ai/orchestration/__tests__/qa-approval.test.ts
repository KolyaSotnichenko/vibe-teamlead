import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { approvalHolds, clearApproval, recordApproval, workTreeFingerprint } from '../qa-approval';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'vtl-approval-')));

describe('the approval record', () => {
  it('holds only for the same project, spec and code', () => {
    const dir = tmp();
    recordApproval(dir, '/p', '/p/specs/001', 'code-1');

    expect(approvalHolds(dir, '/p', '/p/specs/001', 'code-1')).toBe(true);
    expect(approvalHolds(dir, '/p', '/p/specs/001', 'code-2')).toBe(false);
    expect(approvalHolds(dir, '/p', '/p/specs/002', 'code-1')).toBe(false);
    expect(approvalHolds(dir, '/other', '/other/specs/001', 'code-1')).toBe(false);
  });

  it('holds for nothing when the state of the code is unknown', () => {
    const dir = tmp();
    recordApproval(dir, '/p', '/p/specs/001', undefined);
    expect(approvalHolds(dir, '/p', '/p/specs/001', undefined)).toBe(false);
  });

  it('is gone after a clear, and a damaged record holds for nothing', () => {
    const dir = tmp();
    recordApproval(dir, '/p', '/p/specs/001', 'code-1');
    clearApproval(dir, '/p', '/p/specs/001');
    expect(approvalHolds(dir, '/p', '/p/specs/001', 'code-1')).toBe(false);
  });

  it('never throws: a run must not fail over it', () => {
    expect(() => recordApproval('/dev/null/nope', '/p', '/p/s', 'x')).not.toThrow();
    expect(() => clearApproval('/dev/null/nope', '/p', '/p/s')).not.toThrow();
    expect(approvalHolds('/dev/null/nope', '/p', '/p/s', 'x')).toBe(false);
  });
});

describe('workTreeFingerprint', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

  beforeEach(() => {
    repo = tmp();
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
  });

  it('stays the same while nothing changes', async () => {
    expect(await workTreeFingerprint(repo)).toBe(await workTreeFingerprint(repo));
    expect(await workTreeFingerprint(repo)).toBeTruthy();
  });

  it.each([
    ['an uncommitted edit', () => writeFileSync(join(repo, 'a.txt'), 'two\n')],
    ['a new file', () => writeFileSync(join(repo, 'new.txt'), 'x')],
    ['a commit', () => git('commit', '-q', '--allow-empty', '-m', 'second')],
  ])('changes with %s', async (_name, change) => {
    const before = await workTreeFingerprint(repo);
    change();
    expect(await workTreeFingerprint(repo)).not.toBe(before);
  });

  it('notices a new file changing', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x');
    const before = await workTreeFingerprint(repo);
    writeFileSync(join(repo, 'new.txt'), 'longer');
    expect(await workTreeFingerprint(repo)).not.toBe(before);
  });

  it('sees a new file change even with the same size and time', async () => {
    const file = join(repo, 'new.txt');
    const when = new Date('2026-01-01T00:00:00Z');
    writeFileSync(file, 'aaaa');
    utimesSync(file, when, when);
    const before = await workTreeFingerprint(repo);
    writeFileSync(file, 'bbbb');
    utimesSync(file, when, when);
    expect(await workTreeFingerprint(repo)).not.toBe(before);
  });

  it('reads a link as a link, not what it points at', async () => {
    const outside = join(tmp(), 'target');
    writeFileSync(outside, 'one');
    symlinkSync(outside, join(repo, 'link'));
    const before = await workTreeFingerprint(repo);
    writeFileSync(outside, 'two');
    expect(await workTreeFingerprint(repo)).toBe(before);
  });

  it('is unknown with a repository nested inside: its contents can\'t be read from here', async () => {
    const nested = join(repo, 'vendor');
    mkdirSync(nested);
    execFileSync('git', ['init', '-q'], { cwd: nested, stdio: 'ignore' });
    writeFileSync(join(nested, 'x.txt'), 'x');
    await expect(workTreeFingerprint(repo)).resolves.toBeUndefined();
  });

  it('is unknown with a new file too big to read', async () => {
    const huge = join(repo, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, 64 * 1024 * 1024 + 1);
    await expect(workTreeFingerprint(repo)).resolves.toBeUndefined();
  });

  it.each(['--skip-worktree', '--assume-unchanged'])('is unknown when git is told not to look at a file (%s)', async (flag) => {
    git('update-index', flag, 'a.txt');
    await expect(workTreeFingerprint(repo)).resolves.toBeUndefined();
  });

  it("ignores the app's own folder: reports are written there after the review", async () => {
    const before = await workTreeFingerprint(repo);
    mkdirSync(join(repo, '.vibe-teamlead'));
    writeFileSync(join(repo, '.vibe-teamlead', 'report.md'), 'x');
    expect(await workTreeFingerprint(repo)).toBe(before);
  });

  it('is unknown outside a repository', async () => {
    await expect(workTreeFingerprint(tmp())).resolves.toBeUndefined();
  });
});
