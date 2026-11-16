import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTarListing, readZipEntry, windowsTar, zipTool } from '../zip';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zip-helper-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('zipTool', () => {
  it('keeps /usr/bin/unzip with no password prompt on macOS', () => {
    const tool = zipTool('darwin');
    expect(tool.bin).toBe('/usr/bin/unzip');
    expect(tool.listArgs('/a/p.zip')).toEqual(['-l', '-P', '', '/a/p.zip']);
    expect(tool.extractArgs('/a/p.zip', '/t')).toEqual(['-qq', '-o', '-P', '', '/a/p.zip', '-d', '/t']);
    expect(tool.totals('  999999                     42 files\n')).toEqual({ bytes: 999999, files: 42 });
  });

  it("uses Windows' own bsdtar (System32, never Git's GNU tar) on Windows", () => {
    expect(windowsTar({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\tar.exe');
    expect(windowsTar({})).toBe('C:\\Windows\\System32\\tar.exe');
    const tool = zipTool('win32', { SystemRoot: 'D:\\Win' });
    expect(tool.bin).toBe('D:\\Win\\System32\\tar.exe');
    expect(tool.listArgs('C:\\p.zip')).toEqual(['-tvf', 'C:\\p.zip']);
    expect(tool.extractArgs('C:\\p.zip', 'C:\\t')).toEqual(['-xf', 'C:\\p.zip', '-C', 'C:\\t']);
  });
});

describe('parseTarListing', () => {
  it('sums file sizes and counts files, not folders, whatever the date format', () => {
    const listing = [
      'drwxr-xr-x  0 501    0           0 16 Nov 14:21 pkg/',
      '-rw-r--r--  0 501    0          10 16 Nov 14:21 pkg/sub/b c.md',
      '-rw-rw-rw-  0 0      0        1234 Nov 16  2020 pkg/a.css',
      '',
    ].join('\r\n');
    expect(parseTarListing(listing)).toEqual({ bytes: 1244, files: 2 });
    expect(parseTarListing('')).toEqual({ bytes: 0, files: 0 });
  });

  it('refuses a listing it cannot read, or an entry that would land outside the folder', () => {
    expect(parseTarListing('tar: Error opening archive')).toBeNull();
    expect(parseTarListing('-rw-r--r--  0 0 0 5 16 Nov 14:21 ../evil.md')).toBeNull();
    expect(parseTarListing('-rw-r--r--  0 0 0 5 16 Nov 14:21 a/../../evil.md')).toBeNull();
    expect(parseTarListing('-rw-r--r--  0 0 0 5 16 Nov 14:21 /etc/evil.md')).toBeNull();
    expect(parseTarListing('-rw-r--r--  0 0 0 5 16 Nov 14:21 C:\\evil.md')).toBeNull();
  });

  it('reads the real output of bsdtar for a zip', () => {
    const src = join(root, 'src');
    mkdirSync(join(src, 'pkg', 'sub'), { recursive: true });
    writeFileSync(join(src, 'pkg', 'a.css'), 'hello\n');
    writeFileSync(join(src, 'pkg', 'sub', 'b c.md'), 'xxxxxxxxxx');
    execFileSync('/usr/bin/zip', ['-qr', join(root, 'p.zip'), 'pkg'], { cwd: src });
    const listing = execFileSync('/usr/bin/tar', zipTool('win32').listArgs(join(root, 'p.zip')), { encoding: 'utf8' });
    expect(parseTarListing(listing)).toEqual({ bytes: 16, files: 2 });
  });
});

describe('readZipEntry', () => {
  it('reads one entry of a zip as text with tar (Windows), and null when it is missing or not a zip', async () => {
    const src = join(root, 'src');
    mkdirSync(join(src, 'word'), { recursive: true });
    writeFileSync(join(src, 'word', 'document.xml'), '<w:t>Привіт</w:t>');
    const docx = join(root, 'a.docx');
    execFileSync('/usr/bin/zip', ['-qr', docx, 'word'], { cwd: src });
    expect(await readZipEntry(docx, 'word/document.xml', { tar: '/usr/bin/tar' })).toBe('<w:t>Привіт</w:t>');
    expect(await readZipEntry(docx, 'word/missing.xml', { tar: '/usr/bin/tar' })).toBeNull();
    const notZip = join(root, 'b.docx');
    writeFileSync(notZip, readFileSync(join(src, 'word', 'document.xml')));
    expect(await readZipEntry(notZip, 'word/document.xml', { tar: '/usr/bin/tar' })).toBeNull();
  });
});
