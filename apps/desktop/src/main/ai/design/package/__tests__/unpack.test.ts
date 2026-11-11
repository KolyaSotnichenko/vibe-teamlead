import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE_EXTENSIONS, PACKAGE_LIMITS, unpackDesignPackage } from '../unpack';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'unpack-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, content = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('unpackDesignPackage', () => {
  it('exports the limits and extensions', () => {
    expect(PACKAGE_LIMITS).toEqual({ totalBytes: 60 * 1024 * 1024, files: 2000, fileBytes: 20 * 1024 * 1024 });
    expect(PACKAGE_EXTENSIONS.has('.woff2')).toBe(true);
    expect(PACKAGE_EXTENSIONS.has('.sh')).toBe(false);
  });

  it('copies a folder package, keeping only allowed files', async () => {
    const src = path.join(root, 'src');
    write(path.join(src, 'README.md'));
    write(path.join(src, 'tokens.css'));
    write(path.join(src, 'run.sh'));
    write(path.join(src, 'fonts', 'A.otf'));
    const dest = path.join(root, 'dest');
    const r = await unpackDesignPackage(src, dest);
    expect(r.files).toEqual(['README.md', 'fonts/A.otf', 'tokens.css']);
    expect(r.skipped).toEqual([{ path: 'run.sh', reason: 'type' }]);
    expect(readFileSync(path.join(dest, 'tokens.css'), 'utf8')).toBe('x');
  });

  it('unzips a zip into dest', async () => {
    const src = path.join(root, 'src');
    write(path.join(src, 'pkg', 'README.md'));
    write(path.join(src, 'pkg', 'a.css'));
    const zip = path.join(root, 'pkg.zip');
    execFileSync('/usr/bin/zip', ['-qr', zip, 'pkg'], { cwd: src });
    const dest = path.join(root, 'dest');
    const r = await unpackDesignPackage(zip, dest);
    expect(r.files).toContain('pkg/README.md');
    expect(r.files).toContain('pkg/a.css');
  });

  it('never writes outside dest and skips symlinks', async () => {
    const src = path.join(root, 'src');
    write(path.join(src, 'ok.md'));
    symlinkSync('/etc/hosts', path.join(src, 'evil.txt'));
    const dest = path.join(root, 'out', 'dest');
    const r = await unpackDesignPackage(src, dest);
    expect(r.files).toEqual(['ok.md']);
    expect(r.skipped).toEqual([{ path: 'evil.txt', reason: 'unsafe' }]);

    // zip with a traversal entry and a symlink entry
    const work = path.join(root, 'work');
    write(path.join(work, 'sub', 'keep.md'));
    write(path.join(work, 'escape.md'));
    symlinkSync('/etc/hosts', path.join(work, 'sub', 'link.md'));
    const zip = path.join(root, 'evil.zip');
    execFileSync('/usr/bin/zip', ['-qy', zip, 'keep.md', 'link.md', '../escape.md'], {
      cwd: path.join(work, 'sub'),
    });
    const dest2 = path.join(root, 'zdest', 'dest');
    const r2 = await unpackDesignPackage(zip, dest2);
    expect(existsSync(path.join(dest2, '..', 'escape.md'))).toBe(false);
    expect(existsSync(path.join(root, 'zdest', 'escape.md'))).toBe(false);
    expect(r2.skipped.map((s) => s.reason)).toContain('unsafe');
    expect(r2.files).toContain('keep.md');
    expect(r2.files).not.toContain('link.md');
  });

  it('stops at the limits', async () => {
    const src = path.join(root, 'src');
    for (const n of ['a', 'b', 'c']) write(path.join(src, `${n}.md`));
    const r = await unpackDesignPackage(src, path.join(root, 'dest'), { limits: { files: 2 } });
    expect(r.files).toEqual(['a.md', 'b.md']);
    expect(r.skipped).toEqual([{ path: 'c.md', reason: 'limit' }]);

    const r2 = await unpackDesignPackage(src, path.join(root, 'dest2'), { limits: { totalBytes: 2 } });
    expect(r2.files).toEqual(['a.md', 'b.md']);
    expect(r2.skipped).toEqual([{ path: 'c.md', reason: 'limit' }]);

    write(path.join(src, 'big.md'), 'xxxxx');
    const r3 = await unpackDesignPackage(src, path.join(root, 'dest3'), { limits: { fileBytes: 3 } });
    expect(r3.skipped).toEqual([{ path: 'big.md', reason: 'size' }]);
  });

  it('replaces whatever dest held before', async () => {
    const src = path.join(root, 'src');
    write(path.join(src, 'new.md'));
    const dest = path.join(root, 'dest');
    write(path.join(dest, 'stale.md'));
    await unpackDesignPackage(src, dest);
    expect(existsSync(path.join(dest, 'stale.md'))).toBe(false);
    expect(existsSync(path.join(dest, 'new.md'))).toBe(true);
  });

  it('refuses a zip whose declared size or entry count exceeds the limits, leaving dest untouched', async () => {
    const src = path.join(root, 'src');
    write(path.join(src, 'a.md'), 'xxxxxxxxxx');
    write(path.join(src, 'b.md'), 'xxxxxxxxxx');
    const zip = path.join(root, 'p.zip');
    execFileSync('/usr/bin/zip', ['-qr', zip, '.'], { cwd: src });
    const dest = path.join(root, 'dest');
    write(path.join(dest, 'keep.md'));
    await expect(unpackDesignPackage(zip, dest, { limits: { totalBytes: 5 } })).rejects.toThrow(/too large/i);
    await expect(unpackDesignPackage(zip, dest, { limits: { files: 1 } })).rejects.toThrow(/too many/i);
    expect(existsSync(path.join(dest, 'keep.md'))).toBe(true);
  });

  it('runs unzip without a password prompt and with a timeout', async () => {
    const log = path.join(root, 'argv.log');
    const fake = path.join(root, 'fake-unzip.sh');
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> "${log}"\necho "        0                     0 files"\n`,
    );
    chmodSync(fake, 0o755);
    const zip = path.join(root, 'p.zip');
    writeFileSync(zip, 'not really a zip');
    await unpackDesignPackage(zip, path.join(root, 'dest'), { unzip: fake });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toContain('-P ');
  });

  it('refuses when dest and source overlap, deleting nothing', async () => {
    const src = path.join(root, 'src');
    write(path.join(src, 'a.md'));
    await expect(unpackDesignPackage(src, src)).rejects.toThrow(/overlap/i);
    await expect(unpackDesignPackage(src, path.join(root, 'src', 'inner'))).rejects.toThrow(/overlap/i);
    await expect(unpackDesignPackage(path.join(root, 'src'), root)).rejects.toThrow(/overlap/i);
    expect(existsSync(path.join(src, 'a.md'))).toBe(true);
    const zip = path.join(root, 'dest', 'p.zip');
    write(zip);
    await expect(unpackDesignPackage(zip, path.join(root, 'dest'))).rejects.toThrow(/overlap/i);
    expect(existsSync(zip)).toBe(true);
  });
});
