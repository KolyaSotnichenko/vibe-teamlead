import { linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeFileReplacing, writeFileReplacingSync } from '../safe-write';

const dir = () => mkdtempSync(join(tmpdir(), 'vtl-safe-'));

describe.each([
  ['async', writeFileReplacing],
  ['sync', async (file: string, data: string) => writeFileReplacingSync(file, data)],
] as const)('safe write, %s', (_name, write) => {
  it('writes the file and leaves nothing else behind', async () => {
    const d = dir();
    await write(join(d, 'a.json'), 'one');
    await write(join(d, 'a.json'), 'two');
    expect(readFileSync(join(d, 'a.json'), 'utf-8')).toBe('two');
    expect(readdirSync(d)).toEqual(['a.json']);
  });

  it('replaces a symlink an agent left at the path, leaving its target alone', async () => {
    const d = dir();
    const outside = join(dir(), 'precious');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(d, 'a.json'));

    await write(join(d, 'a.json'), 'new');

    expect(readFileSync(outside, 'utf-8')).toBe('untouched');
    expect(lstatSync(join(d, 'a.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(d, 'a.json'), 'utf-8')).toBe('new');
  });

  it('replaces a hard link too, which a write in place would go through', async () => {
    const d = dir();
    const outside = join(d, 'precious');
    writeFileSync(outside, 'untouched');
    linkSync(outside, join(d, 'a.json'));

    await write(join(d, 'a.json'), 'new');

    expect(readFileSync(outside, 'utf-8')).toBe('untouched');
  });

  it('reports a failure and cleans up', async () => {
    const d = dir();
    await expect(write(join(d, 'missing', 'a.json'), 'x')).rejects.toThrow();
    expect(readdirSync(d)).toEqual([]);
  });
});
