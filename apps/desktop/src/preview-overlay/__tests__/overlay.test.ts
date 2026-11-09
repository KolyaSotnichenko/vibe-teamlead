/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startOverlay, type OverlayDeps } from '../overlay';
import { FROM_HOST, FROM_OVERLAY } from '../protocol';

let stop: () => void = () => {};
let posted: Array<Record<string, unknown>> = [];

function host(command: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data: { source: FROM_HOST, ...command }, source: window }));
}

function setup(overrides: Partial<OverlayDeps> = {}) {
  document.body.innerHTML = '<main><h1 id="title">Roadmaply</h1><button id="go">Go</button></main>';
  const deps: OverlayDeps = {
    getElementAtPoint: () => document.getElementById('title'),
    getElementContext: async () => ({
      selector: '#title',
      htmlPreview: '<h1 id="title">Roadmaply</h1>',
      componentName: 'Home',
      filePath: '/wt/apps/web/src/app/page.tsx',
      lineNumber: 7,
      stack: [
        { fileName: '/wt/apps/web/src/app/page.tsx', lineNumber: 7 },
        { fileName: '/wt/apps/web/src/app/layout.tsx', lineNumber: 20, functionName: 'Layout' },
        { fileName: 'node:internal', isIgnoreListed: true },
      ],
    }),
    finder: () => 'main > h1',
    ...overrides,
  };
  stop = startOverlay(window, deps);
  return deps;
}

beforeEach(() => {
  posted = [];
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
    const data = message as Record<string, unknown>;
    if (data.source === FROM_OVERLAY) posted.push(data);
  });
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

/** As Chromium does it: a cancelled pointerdown means no mousedown and no mouseup follow */
const click = (target: Element) => {
  const init = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  const downGoesOn = target.dispatchEvent(new MouseEvent('pointerdown', init));
  if (downGoesOn) target.dispatchEvent(new MouseEvent('mousedown', init));
  const upGoesOn = target.dispatchEvent(new MouseEvent('pointerup', init));
  if (downGoesOn && upGoesOn) target.dispatchEvent(new MouseEvent('mouseup', init));
  return target.dispatchEvent(new MouseEvent('click', init));
};

describe('the notes overlay', () => {
  it("leaves the app's clicks alone until notes mode is on", () => {
    setup();
    const onClick = vi.fn();
    document.getElementById('go')!.addEventListener('click', onClick);
    click(document.getElementById('go')!);
    expect(onClick).toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('in notes mode, takes a click as a pick with the selector, text, component and source frames, and the app never sees it', async () => {
    setup();
    host({ type: 'mode', on: true });
    const onClick = vi.fn();
    document.getElementById('go')!.addEventListener('click', onClick);
    click(document.getElementById('go')!);
    await vi.waitFor(() => expect(posted.some((p) => p.type === 'picked')).toBe(true));
    expect(onClick).not.toHaveBeenCalled();
    const pick = posted.find((p) => p.type === 'picked')!.pick as Record<string, unknown>;
    expect(pick).toMatchObject({ kind: 'element', selector: '#title', text: 'Roadmaply', component: 'Home' });
    expect(pick.frames).toEqual([
      { file: '/wt/apps/web/src/app/page.tsx', line: 7, column: undefined, name: 'Home' },
      { file: '/wt/apps/web/src/app/layout.tsx', line: 20, column: undefined, name: 'Layout' },
    ]);
  });

  it('keeps pointer and touch presses from the app too: menus and drags start on pointerdown', () => {
    setup();
    host({ type: 'mode', on: true });
    const pressed = vi.fn();
    const go = document.getElementById('go')!;
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend']) go.addEventListener(type, pressed);
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend']) go.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    expect(pressed).not.toHaveBeenCalled();
    host({ type: 'mode', on: false });
    go.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("still takes the pick when finding the source hangs (Next's dev server fetching source maps)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      setup({ getElementContext: () => new Promise(() => {}) });
      host({ type: 'mode', on: true });
      click(document.getElementById('title')!);
      await vi.advanceTimersByTimeAsync(1500);
      expect(posted.find((p) => p.type === 'picked')?.pick).toMatchObject({ selector: 'main > h1', text: 'Roadmaply', frames: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a computed selector and no frames when the framework says nothing', async () => {
    setup({ getElementContext: async () => { throw new Error('no React'); } });
    host({ type: 'mode', on: true });
    click(document.getElementById('title')!);
    await vi.waitFor(() => expect(posted.some((p) => p.type === 'picked')).toBe(true));
    expect(posted.find((p) => p.type === 'picked')!.pick).toMatchObject({ selector: 'main > h1', frames: [] });
  });

  it('reports pins whose element is gone, and Escape', () => {
    setup();
    host({ type: 'pins', pins: [{ n: 1, selector: '#title' }, { n: 2, selector: '#gone' }] });
    expect(posted).toContainEqual({ source: FROM_OVERLAY, type: 'detached', ns: [2] });
    host({ type: 'mode', on: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(posted).toContainEqual({ source: FROM_OVERLAY, type: 'escape' });
  });

  it('ignores commands that are not from the host', () => {
    setup();
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'someone', type: 'mode', on: true }, source: window }));
    const onClick = vi.fn();
    document.getElementById('go')!.addEventListener('click', onClick);
    click(document.getElementById('go')!);
    expect(onClick).toHaveBeenCalled();
  });

  it('places a pin once its element appears: pages render after the pins arrive', async () => {
    setup();
    host({ type: 'pins', pins: [{ n: 3, selector: '#late' }] });
    expect(posted).toContainEqual({ source: FROM_OVERLAY, type: 'detached', ns: [3] });
    const late = document.createElement('p');
    late.id = 'late';
    document.querySelector('main')!.appendChild(late);
    await vi.waitFor(() => expect(posted).toContainEqual({ source: FROM_OVERLAY, type: 'detached', ns: [] }));
  });
});
