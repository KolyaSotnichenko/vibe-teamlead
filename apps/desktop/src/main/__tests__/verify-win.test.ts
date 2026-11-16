import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { missingFromWindowsApp, asarFiles } = require(resolve(__dirname, '../../../scripts/verify-win.cjs')) as {
  missingFromWindowsApp: (resources: Set<string>, asar: Set<string>) => string[];
  asarFiles: (path: string) => Set<string>;
};

const COMPLETE = [
  'app.asar',
  'claude-code/claude.exe',
  'codegraph/node.exe',
  'codegraph/lib/dist/bin/codegraph.js',
  'scanners/gitleaks.exe',
  'scanners/osv-scanner.exe',
  'app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64/conpty.node',
  'app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64/conpty_console_list.node',
  'plugins/drawio/.claude-plugin/plugin.json',
  'plugins/frontend-design/skills/frontend-design/SKILL.md',
  'plugins/gsap-skills/README.md',
  'plugins/superpowers/.claude-plugin/plugin.json',
  'plugins/ux-review/SKILL.md',
  'plugins/vibe-teamlead-skills/.claude-plugin/plugin.json',
];
const ASAR = ['/package.json', '/out/main/index.js', '/out/preview/overlay.js'];

describe('missingFromWindowsApp', () => {
  it('nothing when the app has everything', () => {
    expect(missingFromWindowsApp(new Set(COMPLETE), new Set(ASAR))).toEqual([]);
  });

  it.each([
    ['claude-code/claude.exe'],
    ['codegraph/node.exe'],
    ['codegraph/lib/dist/bin/codegraph.js'],
    ['scanners/gitleaks.exe'],
    ['scanners/osv-scanner.exe'],
    ['app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64/conpty.node'],
  ])('names %s when it is missing', (file) => {
    const resources = new Set(COMPLETE.filter((f) => f !== file));
    expect(missingFromWindowsApp(resources, new Set(ASAR))).toContain(file);
  });

  it('names a plugin with no files', () => {
    const resources = new Set(COMPLETE.filter((f) => !f.startsWith('plugins/gsap-skills/')));
    expect(missingFromWindowsApp(resources, new Set(ASAR))).toEqual(['plugins/gsap-skills/']);
  });

  it('names the preview overlay when the asar lacks it', () => {
    expect(missingFromWindowsApp(new Set(COMPLETE), new Set(['/package.json']))).toEqual(['app.asar:/out/preview/overlay.js']);
  });

  it('does not take a macOS layout for a Windows one', () => {
    const mac = COMPLETE.map((f) => f.replace('claude.exe', 'claude').replace('gitleaks.exe', 'gitleaks'));
    expect(missingFromWindowsApp(new Set(mac), new Set(ASAR))).toEqual(['claude-code/claude.exe', 'scanners/gitleaks.exe']);
  });
});

/** An asar archive's header the way @electron/asar writes it (Chromium pickles). */
function fakeAsar(header: object): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const headerPickle = Buffer.alloc(8 + padded.length);
  headerPickle.writeUInt32LE(4 + padded.length, 0);
  headerPickle.writeInt32LE(json.length, 4);
  padded.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, Buffer.from('payload')]);
}

describe('asarFiles', () => {
  it('lists the files in an archive, folders walked', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vtl-asar-')), 'app.asar');
    writeFileSync(
      path,
      fakeAsar({
        files: {
          'package.json': { size: 2, offset: '0' },
          out: { files: { preview: { files: { 'overlay.js': { size: 1, offset: '2' } } }, main: { files: {} } } },
        },
      }),
    );
    expect([...asarFiles(path)].sort()).toEqual(['/out/preview/overlay.js', '/package.json']);
  });
});
