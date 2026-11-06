import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { differences, verifyDmg } = require(resolve(__dirname, '../../../scripts/verify-dmg.cjs')) as {
  differences: (app: Map<string, number>, image: Map<string, number>) => string[];
  verifyDmg: (dmg: string, app: string, options?: { signature?: boolean }) => void;
};

describe('differences', () => {
  const files = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it('nothing when the image holds the app', () => {
    expect(differences(files({ a: 1, b: 2 }), files({ a: 1, b: 2 }))).toEqual([]);
  });

  it('names a file that did not make it: a full volume drops files without an error', () => {
    expect(differences(files({ a: 1, 'Electron Framework': 175 }), files({ a: 1 }))).toEqual(['missing: Electron Framework']);
  });

  it('names a file cut short', () => {
    expect(differences(files({ a: 10 }), files({ a: 4 }))).toEqual(['wrong size: a (10 in the app, 4 in the image)']);
  });
});

describe.skipIf(process.platform !== 'darwin')('verifyDmg', () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-dmg-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** An app folder, and an image of `imageFiles` under the same name */
  const build = (appFiles: Record<string, string>, imageFiles: Record<string, string>) => {
    const write = (root: string, files: Record<string, string>) => {
      const app = join(root, 'Demo.app');
      mkdirSync(join(app, 'Contents'), { recursive: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(join(app, 'Contents', name), text);
      return app;
    };
    const app = write(temp(), appFiles);
    const source = temp();
    write(source, imageFiles);
    const dmg = join(temp(), 'demo.dmg');
    execFileSync('hdiutil', ['create', '-quiet', '-volname', 'Demo', '-srcfolder', source, '-format', 'UDZO', dmg]);
    return { app, dmg };
  };

  it('passes a whole image', () => {
    const { app, dmg } = build({ a: 'one' }, { a: 'one' });
    expect(() => verifyDmg(dmg, app, { signature: false })).not.toThrow();
  }, 60_000);

  it('fails an image with a file missing, and says which', () => {
    const { app, dmg } = build({ a: 'one', framework: 'big' }, { a: 'one' });
    expect(() => verifyDmg(dmg, app, { signature: false })).toThrow(/missing: .*framework/);
  }, 60_000);
});
