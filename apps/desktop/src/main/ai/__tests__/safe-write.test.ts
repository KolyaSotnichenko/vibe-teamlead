import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it.each([
    ['a folder inside the spec directory', ['.vibe-teamlead', 'specs', '001', 'memory']],
    ['the spec directory', ['.vibe-teamlead', 'specs', '001']],
    ["the app's folder itself", ['.vibe-teamlead']],
  ])('refuses to write through a link at %s', async (_name, parts) => {
    const project = dir();
    const outside = dir();
    mkdirSync(join(project, ...parts.slice(0, -1)), { recursive: true });
    symlinkSync(outside, join(project, ...parts));
    const file = join(project, '.vibe-teamlead', 'specs', '001', 'memory', 'a.json');

    await expect(write(file, 'x')).rejects.toThrow(/link/i);

    expect(readdirSync(outside)).toEqual([]);
  });

  it("doesn't mind links above the app's folder: the project may live behind one", async () => {
    const real = dir();
    mkdirSync(join(real, '.vibe-teamlead', 'specs'), { recursive: true });
    const alias = join(dir(), 'alias');
    symlinkSync(real, alias);

    await write(join(alias, '.vibe-teamlead', 'specs', 'a.json'), 'x');

    expect(existsSync(join(real, '.vibe-teamlead', 'specs', 'a.json'))).toBe(true);
  });

  it('reports a failure and cleans up', async () => {
    const d = dir();
    await expect(write(join(d, 'missing', 'a.json'), 'x')).rejects.toThrow();
    expect(readdirSync(d)).toEqual([]);
  });
});
