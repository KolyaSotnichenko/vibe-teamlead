import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { approvalHolds, approvedAsItIs, clearApproval, recordApproval, workTreeFingerprint, autoMergeRefusal, PREVIEW_HOLD } from '../qa-approval';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'vtl-approval-')));

describe('the approval record', () => {
  it('vouches for a folder only as QA saw it, by spec id or spec folder', async () => {
    const dir = tmp();
    const project = tmp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(project, 'a.txt'), 'one\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
    writeFileSync(join(project, 'a.txt'), 'reviewed\n');
    expect(await approvedAsItIs(project, '001', dir)).toBe(false);

    recordApproval(dir, project, join(project, 'specs', '001'), await workTreeFingerprint(project));
    expect(await approvedAsItIs(project, '001', dir)).toBe(true);

    writeFileSync(join(project, 'a.txt'), 'changed after the review\n');
    expect(await approvedAsItIs(project, '001', dir)).toBe(false);
  });

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

  it('is unknown with a nested repository added to git: only its commit shows, not its files', async () => {
    const nested = join(repo, 'vendor');
    mkdirSync(nested);
    const inner = (...args: string[]) => execFileSync('git', args, { cwd: nested, stdio: 'ignore' });
    inner('init', '-q');
    inner('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
    git('add', 'vendor');
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

describe('what an automatic merge needs', () => {
  it('goes ahead on an approval of exactly this code', async () => {
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', async () => true)).resolves.toBeNull();
  });

  it('is refused without one, whatever the task folder says', async () => {
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', async () => false)).resolves.toEqual(expect.any(String));
  });

  it('is refused without a task folder to check', async () => {
    await expect(autoMergeRefusal({ auto: true }, null, '001-a', async () => true)).resolves.toEqual(expect.any(String));
  });

  it('asks nothing of a merge the user started', async () => {
    const approved = vi.fn(async () => false);
    await expect(autoMergeRefusal({}, '/wt', '001-a', approved)).resolves.toBeNull();
    await expect(autoMergeRefusal(undefined, null, '001-a', approved)).resolves.toBeNull();
    expect(approved).not.toHaveBeenCalled();
  });
});

describe('UI tasks wait for the preview', () => {
  const approved = async () => true;

  it('holds an approved task that changed UI files, when the switch is on', async () => {
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', approved, async () => true)).resolves.toBe(PREVIEW_HOLD);
  });

  it("holds it when the changed files can't be listed: the safe side", async () => {
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', approved, async () => undefined)).resolves.toBe(PREVIEW_HOLD);
  });

  it('lets a task without UI changes merge, and asks nothing with the switch off or for a merge by hand', async () => {
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', approved, async () => false)).resolves.toBeNull();
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', approved)).resolves.toBeNull();
    const touches = vi.fn(async () => true);
    await expect(autoMergeRefusal({}, '/wt', '001-a', approved, touches)).resolves.toBeNull();
    expect(touches).not.toHaveBeenCalled();
  });

  it('says QA did not approve before anything about the preview', async () => {
    await expect(autoMergeRefusal({ auto: true }, '/wt', '001-a', async () => false, async () => true)).resolves.not.toBe(PREVIEW_HOLD);
  });
});
