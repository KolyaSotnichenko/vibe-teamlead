import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getPlatformKey } from '..';

const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const on = (platform: string) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });
afterEach(() => Object.defineProperty(process, 'platform', real));

describe('getPlatformKey', () => {
  it("names the platform as Node does, for tables keyed by 'darwin' | 'win32' | 'linux'", () => {
    on('darwin');
    expect(getPlatformKey()).toBe('darwin');
    on('win32');
    expect(getPlatformKey()).toBe('win32');
    on('linux');
    expect(getPlatformKey()).toBe('linux');
  });

  it('counts another Unix-like system as Linux', () => {
    on('freebsd');
    expect(getPlatformKey()).toBe('linux');
  });
});

// F-024, CLAUDE.md: use the platform helpers, not process.platform
describe('process.platform', () => {
  const src = join(__dirname, '..', '..', '..');
  const ALLOWED = [join('main', 'platform'), join('shared', 'platform.ts')];
  const files = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['__tests__', '__mocks__', 'mocks', 'node_modules'].includes(entry.name)) files(file, out);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && entry.name !== 'browser-mock.ts') out.push(file);
    }
    return out;
  };

  it('is read only by the platform modules', () => {
    const direct = files(src)
      .map((file) => relative(src, file))
      .filter((file) => !ALLOWED.some((allowed) => file.startsWith(allowed)))
      .filter((file) => /\bprocess\.platform\b/.test(readFileSync(join(src, file), 'utf-8')));
    expect(direct).toEqual([]);
  });
});
