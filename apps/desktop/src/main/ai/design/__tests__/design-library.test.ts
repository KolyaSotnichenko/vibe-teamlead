import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyLibraryToBase, libraryDir, publishToLibrary, readLibrary } from '../design-library';

function taskSpec(root: string, specId: string, frames: Array<{ file: string; title: string; kind: 'wireframe' | 'screen'; html: string }>): string {
  const dir = path.join(root, '.vibe-teamlead', 'specs', specId);
  for (const f of frames) {
    mkdirSync(path.dirname(path.join(dir, 'design', f.file)), { recursive: true });
    writeFileSync(path.join(dir, 'design', f.file), f.html);
  }
  writeFileSync(path.join(dir, 'design', 'canvas.json'), JSON.stringify({ frames: frames.map((f, i) => ({ file: f.file, title: f.title, kind: f.kind, width: 1280, height: 900, x: i * 1360, y: 0 })) }));
  return dir;
}

describe("the project's design library", () => {
  it("collects every task's frames, the same file name replacing the older version", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const a = taskSpec(root, '051-roadmap', [
      { file: 'screens/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'screen', html: 'v1' },
      { file: 'wireframes/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'wireframe', html: 'w1' },
    ]);
    publishToLibrary(root, a, { taskId: '051-roadmap', now: new Date('2026-11-10T10:00:00Z') });
    const b = taskSpec(root, '052-changelog', [
      { file: 'screens/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'screen', html: 'v2' },
      { file: 'screens/changelog.html', title: 'Changelog', kind: 'screen', html: 'c1' },
    ]);
    publishToLibrary(root, b, { taskId: '052-changelog', now: new Date('2026-11-11T10:00:00Z') });

    const library = readLibrary(root);
    // Wireframes in one band, the screens in the band under them
    expect(library.frames.map((f) => [f.file, f.taskId, f.y])).toEqual([
      ['wireframes/roadmap-desktop.html', '051-roadmap', 0],
      ['screens/changelog.html', '052-changelog', 1200],
      ['screens/roadmap-desktop.html', '052-changelog', 1200],
    ]);
    expect(readFileSync(path.join(libraryDir(root), 'screens', 'roadmap-desktop.html'), 'utf-8')).toBe('v2');
  });

  it("gives the next task's designer the library as its starting point, under design/base/", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    publishToLibrary(root, taskSpec(root, '051', [{ file: 'screens/roadmap.html', title: 'Roadmap', kind: 'screen', html: 'v1' }]), { taskId: '051' });
    const next = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-wt-')), 'spec');
    expect(copyLibraryToBase(root, next)).toBe(1);
    expect(readFileSync(path.join(next, 'design', 'base', 'screens', 'roadmap.html'), 'utf-8')).toBe('v1');
    expect(existsSync(path.join(next, 'design', 'base', 'canvas.json'))).toBe(true);
    expect(copyLibraryToBase(mkdtempSync(path.join(tmpdir(), 'vtl-empty-')), next)).toBe(0);
  });
});

describe('what the library refuses', () => {
  it('a frame that is a link, or whose path leaves the library, is not copied', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const spec = taskSpec(root, '060', [{ file: 'screens/ok.html', title: 'Ok', kind: 'screen', html: 'ok' }]);
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-out-')), 'secret.html');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(spec, 'design', 'screens', 'leak.html'));
    mkdirSync(path.join(spec, 'design', 'other'), { recursive: true });
    writeFileSync(path.join(spec, 'design', 'other', 'x.html'), 'x');
    writeFileSync(path.join(spec, 'design', 'canvas.json'), JSON.stringify({ frames: [
      { file: 'screens/ok.html', title: 'Ok', kind: 'screen', width: 400, height: 400, x: 0, y: 0 },
      { file: 'screens/leak.html', title: 'Leak', kind: 'screen', width: 400, height: 400, x: 0, y: 0 },
      { file: 'other/x.html', title: 'Elsewhere', kind: 'screen', width: 400, height: 400, x: 0, y: 0 },
    ] }));
    expect(publishToLibrary(root, spec, { taskId: '060' })).toBe(1);
    expect(readLibrary(root).frames.map((f) => f.file)).toEqual(['screens/ok.html']);
    expect(existsSync(path.join(libraryDir(root), 'screens', 'leak.html'))).toBe(false);
    expect(existsSync(path.join(libraryDir(root), 'other'))).toBe(false);
  });

  it('a library entry that is a link is not copied into a task', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    publishToLibrary(root, taskSpec(root, '061', [{ file: 'screens/a.html', title: 'A', kind: 'screen', html: 'a' }]), { taskId: '061' });
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-out-')), 'secret.html');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(libraryDir(root), 'screens', 'b.html'));
    const canvas = JSON.parse(readFileSync(path.join(libraryDir(root), 'canvas.json'), 'utf-8'));
    canvas.frames.push({ ...canvas.frames[0], file: 'screens/b.html' });
    writeFileSync(path.join(libraryDir(root), 'canvas.json'), JSON.stringify(canvas));
    const next = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-wt-')), 'spec');
    expect(copyLibraryToBase(root, next)).toBe(1);
    expect(existsSync(path.join(next, 'design', 'base', 'screens', 'b.html'))).toBe(false);
  });

  it('keeps a responsive page once per width it is shown at', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-lib-'));
    const spec = taskSpec(root, '062', [{ file: 'screens/table.html', title: 'Table · desktop', kind: 'screen', html: 't' }]);
    writeFileSync(path.join(spec, 'design', 'canvas.json'), JSON.stringify({ frames: [
      { file: 'screens/table.html', title: 'Table · desktop', kind: 'screen', width: 1280, height: 900, x: 0, y: 0 },
      { file: 'screens/table.html', title: 'Table · phone', kind: 'screen', width: 390, height: 844, x: 1360, y: 0 },
    ] }));
    publishToLibrary(root, spec, { taskId: '062' });
    expect(readLibrary(root).frames.map((f) => [f.file, f.width])).toEqual([['screens/table.html', 1280], ['screens/table.html', 390]]);
  });
});
