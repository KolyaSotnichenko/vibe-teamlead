import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
