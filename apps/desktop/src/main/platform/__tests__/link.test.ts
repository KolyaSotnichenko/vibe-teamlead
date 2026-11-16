import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { linkIntoWorktree, type LinkFs } from '../link';

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });

function fakeFs(isDir: boolean, symlink: LinkFs['symlinkSync'] = vi.fn()) {
  return {
    symlinkSync: symlink,
    copyFileSync: vi.fn<LinkFs['copyFileSync']>(),
    statSync: vi.fn(() => ({ isDirectory: () => isDir })) as unknown as LinkFs['statSync'],
  };
}

describe('linkIntoWorktree on Windows', () => {
  it('links a folder with a junction (no admin rights or Developer Mode needed)', () => {
    const fs = fakeFs(true);
    expect(linkIntoWorktree('C:\\p\\.claude', 'C:\\w\\.claude', 'win32', fs)).toBe('junction');
    expect(fs.symlinkSync).toHaveBeenCalledWith('C:\\p\\.claude', 'C:\\w\\.claude', 'junction');
  });

  it('links a file with a file symlink, and copies it when Windows refuses the symlink (EPERM)', () => {
    const ok = fakeFs(false);
    expect(linkIntoWorktree('C:\\p\\.env', 'C:\\w\\.env', 'win32', ok)).toBe('symlink');
    expect(ok.symlinkSync).toHaveBeenCalledWith('C:\\p\\.env', 'C:\\w\\.env', 'file');
    const refused = fakeFs(false, vi.fn(() => {
      throw eperm();
    }));
    expect(linkIntoWorktree('C:\\p\\.env', 'C:\\w\\.env', 'win32', refused)).toBe('copy');
    expect(refused.copyFileSync).toHaveBeenCalledWith('C:\\p\\.env', 'C:\\w\\.env');
  });

  it('never copies a folder (node_modules): the error is passed on', () => {
    const fs = fakeFs(true, vi.fn(() => {
      throw eperm();
    }));
    expect(() => linkIntoWorktree('C:\\p\\node_modules', 'C:\\w\\node_modules', 'win32', fs)).toThrow(/EPERM/);
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });
});

describe('linkIntoWorktree on macOS', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'link-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('makes a relative symlink, as before', () => {
    mkdirSync(join(root, 'p'));
    mkdirSync(join(root, 'w'));
    writeFileSync(join(root, 'p', '.env'), 'A=1');
    expect(linkIntoWorktree(join(root, 'p', '.env'), join(root, 'w', '.env'), 'darwin')).toBe('symlink');
    expect(readlinkSync(join(root, 'w', '.env'))).toBe(join('..', 'p', '.env'));
    expect(readFileSync(join(root, 'w', '.env'), 'utf8')).toBe('A=1');
  });

  it('copies a file when the symlink is refused (EPERM), and passes other errors on', () => {
    const refused = fakeFs(false, vi.fn(() => {
      throw eperm();
    }));
    expect(linkIntoWorktree('/p/.env', '/w/.env', 'darwin', refused)).toBe('copy');
    const other = fakeFs(false, vi.fn(() => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    }));
    expect(() => linkIntoWorktree('/p/.env', '/w/.env', 'darwin', other)).toThrow(/EEXIST/);
  });
});
