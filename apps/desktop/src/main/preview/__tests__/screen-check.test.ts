import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ScreenCatalog } from '../../ai/design/screen-catalog';
import { runScreenCheck, type ScreenCheckDeps } from '../screen-check';

const catalog: ScreenCatalog = {
  screens: [
    { id: 'screens/plan-board.html', width: 1280, path: '/plans', steps: [], mask: [] },
    { id: 'screens/my-tasks.html', width: 1280, path: '/my-tasks', steps: [], mask: [] },
    { id: 'screens/gantt.html', width: 1280, path: '/projects', steps: [], mask: [] },
    { id: 'screens/roles.html', width: 1280, path: '/admin/roles', steps: [], mask: [] },
  ],
};

/** A "picture" is its text; its bitmap is one pixel per character */
const deps = (shots: Record<string, string | Error>): ScreenCheckDeps => ({
  capture: vi.fn(async (_url: string, screens: ScreenCatalog) =>
    screens.screens.map((s) => {
      const shot = shots[s.id];
      return shot instanceof Error ? { id: s.id, width: s.width, error: shot.message } : { id: s.id, width: s.width, png: Buffer.from(shot ?? 'same') };
    }),
  ),
  bitmap: (png) => {
    const text = png.toString();
    const data = new Uint8Array(text.length * 4);
    for (let i = 0; i < text.length; i++) data.set([text.charCodeAt(i), 0, 0, 255], i * 4);
    return { width: text.length, height: 1, data };
  },
});

function baseline(pictures: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vt-baseline-'));
  for (const [file, text] of Object.entries(pictures)) writeFileSync(path.join(dir, file), text);
  return dir;
}

describe('runScreenCheck', () => {
  it("finds the screens that changed since the last merge, keeps before and after, and leaves out the task's own", async () => {
    const before = baseline({
      'screens_plan-board.html@1280.png': 'aaaa',
      'screens_my-tasks.html@1280.png': 'bbbb',
      'screens_roles.html@1280.png': 'cccc',
    });
    const out = mkdtempSync(path.join(tmpdir(), 'vt-out-'));
    const d = deps({ 'screens/plan-board.html': 'aaaa', 'screens/my-tasks.html': 'b!!!', 'screens/gantt.html': 'new!', 'screens/roles.html': 'cXXX' });

    const result = await runScreenCheck({ baseUrl: 'http://localhost:5173', catalog, baselineDir: before, outDir: out, exclude: new Set(['screens/roles.html']) }, d);

    expect(result.changed).toEqual([
      { id: 'screens/my-tasks.html', width: 1280, before: path.join(out, 'before', 'screens_my-tasks.html@1280.png'), after: path.join(out, 'after', 'screens_my-tasks.html@1280.png') },
    ]);
    expect(result.unchanged).toBe(1);
    expect(result.added).toEqual([{ id: 'screens/gantt.html', width: 1280 }]);
    expect(result.failed).toEqual([]);
    expect(readFileSync(result.changed[0].after, 'utf-8')).toBe('b!!!');
    expect(readFileSync(result.changed[0].before, 'utf-8')).toBe('bbbb');
    // The task's own screen is not captured at all: QA shows it itself
    expect((d.capture as ReturnType<typeof vi.fn>).mock.calls[0][1].screens.map((s: { id: string }) => s.id)).not.toContain('screens/roles.html');
  });

  it("reports a screen it could not reach, without counting it as changed", async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'vt-out-'));
    const result = await runScreenCheck(
      { baseUrl: 'http://localhost:5173', catalog, baselineDir: baseline({}), outDir: out },
      deps({ 'screens/plan-board.html': new Error('not found: "#board"') }),
    );
    expect(result.failed).toEqual([{ id: 'screens/plan-board.html', width: 1280, error: 'not found: "#board"' }]);
    expect(result.changed).toEqual([]);
  });

  it('without a baseline only captures: the pictures become the next baseline', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'vt-out-'));
    const result = await runScreenCheck({ baseUrl: 'http://localhost:5173', catalog, outDir: out }, deps({}));
    expect(result.changed).toEqual([]);
    expect(result.added).toHaveLength(4);
    expect(existsSync(path.join(out, 'after', 'screens_gantt.html@1280.png'))).toBe(true);
  });

  it("writes only into a real folder: a link an agent put in its place is removed, never followed", async () => {
    const spec = mkdtempSync(path.join(tmpdir(), 'vt-spec-'));
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'vt-elsewhere-'));
    symlinkSync(elsewhere, path.join(spec, 'regression'));
    await runScreenCheck({ baseUrl: 'http://localhost:5173', catalog, outDir: path.join(spec, 'regression') }, deps({}));
    expect(lstatSync(path.join(spec, 'regression')).isSymbolicLink()).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('captures nothing for an empty catalog', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'vt-out-'));
    mkdirSync(out, { recursive: true });
    const d = deps({});
    const result = await runScreenCheck({ baseUrl: 'http://localhost:5173', catalog: { screens: [] }, outDir: out }, d);
    expect(result).toEqual({ changed: [], unchanged: 0, added: [], failed: [] });
    expect(d.capture).not.toHaveBeenCalled();
  });
});
