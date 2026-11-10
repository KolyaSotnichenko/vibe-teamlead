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
