import { describe, expect, it } from 'vitest';

import { fitView, frameUrl, visibleFrames, zoomAt } from '../design-canvas';

const frames = [
  { file: 'wireframes/a.html', title: 'A', kind: 'wireframe' as const, width: 1280, height: 900, x: 0, y: 0 },
  { file: 'wireframes/b.html', title: 'B', kind: 'wireframe' as const, width: 390, height: 844, x: 1360, y: 0 },
  { file: 'screens/a.html', title: 'A', kind: 'screen' as const, width: 1280, height: 900, x: 0, y: 1200 },
];

describe('the design canvas', () => {
  it('fits every frame into the view with a margin', () => {
    const view = fitView(frames, { width: 1000, height: 700 });
    // bounds 1750 × 2128 (titles above the top row) → the height decides
    expect(view.scale).toBeCloseTo((700 - 2 * 48) / 2128, 4);
    expect(view.x).toBeGreaterThan(0);
    expect(fitView([], { width: 1000, height: 700 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('zooms around the pointer, within limits', () => {
    const next = zoomAt({ x: 0, y: 0, scale: 0.5 }, { x: 200, y: 100 }, 2);
    expect(next.scale).toBe(1);
    // the canvas point under the pointer stays under it
    expect((200 - next.x) / next.scale).toBeCloseTo((200 - 0) / 0.5);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 100).scale).toBe(2);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 0.001).scale).toBe(0.05);
  });

  it('shows the wireframes, the screens, or both', () => {
    expect(visibleFrames(frames, 'wireframes').map((f) => f.file)).toEqual(['wireframes/a.html', 'wireframes/b.html']);
    expect(visibleFrames(frames, 'screens').map((f) => f.file)).toEqual(['screens/a.html']);
    expect(visibleFrames(frames, 'all')).toHaveLength(3);
  });

  it('a frame is served from vt-design://, or from the preview mock', () => {
    expect(frameUrl('031-swap theme', 'screens/a b.html')).toBe('vt-design://task/031-swap%20theme/screens/a%20b.html');
    expect(frameUrl('t', 'screens/a.html', { 'screens/a.html': 'data:text/html,x' })).toBe('data:text/html,x');
  });
});
