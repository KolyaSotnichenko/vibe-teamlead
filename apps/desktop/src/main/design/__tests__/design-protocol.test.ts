import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DESIGN_CSP, designAsset, libraryAsset, parseDesignUrl, parseLibraryUrl } from '../design-protocol';

function specDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vtl-proto-'));
  mkdirSync(path.join(dir, 'design', 'screens'), { recursive: true });
  mkdirSync(path.join(dir, 'design', 'shots'), { recursive: true });
  writeFileSync(path.join(dir, 'design', 'screens', 'roadmap.html'), '<!doctype html><html><body><a href="item.html">Item</a></body></html>');
  writeFileSync(path.join(dir, 'design', 'shots', 'roadmap-390.png'), 'png');
  writeFileSync(path.join(dir, 'qa-roadmap-390.png'), 'png');
  writeFileSync(path.join(dir, 'spec.md'), '# secret-ish');
  return dir;
}

describe('vt-design:// URLs', () => {
  it('name a task and a file under its design folder', () => {
    expect(parseDesignUrl('vt-design://task/031-swap-theme/screens/roadmap.html')).toEqual({ taskId: '031-swap-theme', file: 'screens/roadmap.html', area: 'design' });
    expect(parseDesignUrl('vt-design://task/031/spec/qa-roadmap-390.png')).toEqual({ taskId: '031', file: 'qa-roadmap-390.png', area: 'spec' });
    expect(parseDesignUrl('vt-design://other/031/x.html')).toBeNull();
    expect(parseDesignUrl('https://example.com/x.html')).toBeNull();
  });
});

describe('what vt-design:// serves', () => {
  it('an HTML frame with a strict CSP and the comment script added', () => {
    const asset = designAsset(specDir(), { taskId: '031', file: 'screens/roadmap.html', area: 'design' });
    expect(asset?.mime).toBe('text/html; charset=utf-8');
    expect(asset?.headers['Content-Security-Policy']).toBe(DESIGN_CSP);
    expect(String(asset?.body)).toContain('<a href="item.html">Item</a>');
    expect(String(asset?.body)).toContain('vt-design:pick');
  });

  it('images of the design and of the QA comparison, nothing else of the spec', () => {
    const dir = specDir();
    expect(designAsset(dir, { taskId: '031', file: 'shots/roadmap-390.png', area: 'design' })?.mime).toBe('image/png');
    expect(designAsset(dir, { taskId: '031', file: 'qa-roadmap-390.png', area: 'spec' })?.mime).toBe('image/png');
    expect(designAsset(dir, { taskId: '031', file: 'spec.md', area: 'spec' })).toBeNull();
    expect(designAsset(dir, { taskId: '031', file: '../spec.md', area: 'design' })).toBeNull();
    expect(designAsset(dir, { taskId: '031', file: 'screens/missing.html', area: 'design' })).toBeNull();
  });

  it('the CSP allows only fonts and the pinned GSAP from the network', () => {
    expect(DESIGN_CSP).toContain("default-src 'none'");
    expect(DESIGN_CSP).toContain('https://fonts.googleapis.com');
    expect(DESIGN_CSP).toContain('https://cdn.jsdelivr.net/npm/gsap@3.13.0/');
    expect(DESIGN_CSP).toContain("connect-src 'none'");
  });
});

describe('links in the design folder', () => {
  it('a symlink that points outside is not served', async () => {
    const { symlinkSync } = await import('node:fs');
    const dir = specDir();
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vtl-out-')), 'secret.html');
    writeFileSync(outside, '<p>secret</p>');
    symlinkSync(outside, path.join(dir, 'design', 'screens', 'leak.html'));
    expect(designAsset(dir, { taskId: '031', file: 'screens/leak.html', area: 'design' })).toBeNull();
  });
});

describe("the project's library over vt-design://project/", () => {
  it('names a project and a file under its library', () => {
    expect(parseLibraryUrl('vt-design://project/p-1/screens/roadmap.html')).toEqual({ projectId: 'p-1', file: 'screens/roadmap.html' });
    expect(parseLibraryUrl('vt-design://task/t/screens/roadmap.html')).toBeNull();
  });

  it('serves its frames with the same CSP, and nothing outside it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vtl-proj-'));
    const lib = path.join(root, '.vibe-teamlead', 'design', 'library', 'screens');
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(lib, 'roadmap.html'), '<body>r</body>');
    writeFileSync(path.join(root, '.vibe-teamlead', 'design', 'secret.html'), 'no');
    expect(libraryAsset(root, 'screens/roadmap.html')?.headers['Content-Security-Policy']).toBe(DESIGN_CSP);
    expect(libraryAsset(root, '../secret.html')).toBeNull();
  });
});
