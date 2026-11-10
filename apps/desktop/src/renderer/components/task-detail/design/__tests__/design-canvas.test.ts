import { describe, expect, it } from 'vitest';

import { fitView, flowArrows, frameUrl, outgoingCounts, resolveLink, startFrame, visibleArrows, visibleFrames, zoomAt } from '../design-canvas';

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

describe('flows between frames', () => {
  const flowFrames = [
    { file: 'screens/table.html', title: 'Table · desktop', kind: 'screen' as const, width: 1280, height: 900, x: 0, y: 0, start: true },
    { file: 'screens/table.html', title: 'Table · phone', kind: 'screen' as const, width: 390, height: 844, x: 1360, y: 0 },
    { file: 'screens/table-states.html', title: 'States · desktop', kind: 'screen' as const, width: 1280, height: 900, x: 1830, y: 0 },
  ];

  it('an arrow from each link to the frame it opens, at the same width when there is one', () => {
    const arrows = flowArrows(flowFrames, {
      'screens/table.html@1280': [{ href: 'table-states.html', x: 100, y: 200, w: 80, h: 30 }],
      'screens/table.html@390': [{ href: './table-states.html#top', x: 10, y: 50, w: 60, h: 20 }, { href: 'https://example.com', x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(arrows).toEqual([
      { from: { x: 180, y: 215 }, to: { x: 1830, y: 40 }, key: 'screens/table.html@1280>screens/table-states.html@1280#0' },
      { from: { x: 1430, y: 60 }, to: { x: 1830, y: 40 }, key: 'screens/table.html@390>screens/table-states.html@1280#0' },
    ]);
  });

  it('a link to a page that is not on the canvas draws nothing', () => {
    expect(flowArrows(flowFrames, { 'screens/table.html@1280': [{ href: 'missing.html', x: 0, y: 0, w: 10, h: 10 }] })).toEqual([]);
  });

  it('the prototype starts at the frame marked start, else the first screen', () => {
    expect(startFrame(flowFrames)?.title).toBe('Table · desktop');
    expect(startFrame(flowFrames.map(({ start: _s, ...f }) => f))?.title).toBe('Table · desktop');
  });

  it('a link resolves against the frame it is in', () => {
    expect(resolveLink('screens/table.html', '../wireframes/table.html')).toBe('wireframes/table.html');
    expect(resolveLink('screens/table.html', 'table-states.html?x=1')).toBe('screens/table-states.html');
    expect(resolveLink('screens/table.html', 'https://example.com/a.html')).toBeNull();
  });
});

describe('which arrows show', () => {
  const arrows = [
    { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, key: 'a.html@1280>b.html@1280#0' },
    { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, key: 'b.html@1280>c.html@1280#0' },
    { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, key: 'c.html@390>a.html@390#0' },
  ];

  it("only the focused frame's, in and out, unless all are asked for", () => {
    expect(visibleArrows(arrows, 'b.html@1280', false).map((a) => a.key)).toEqual(['a.html@1280>b.html@1280#0', 'b.html@1280>c.html@1280#0']);
    expect(visibleArrows(arrows, null, false)).toEqual([]);
    expect(visibleArrows(arrows, null, true)).toHaveLength(3);
  });

  it('counts the transitions out of each frame', () => {
    expect(outgoingCounts(arrows)).toEqual({ 'a.html@1280': 1, 'b.html@1280': 1, 'c.html@390': 1 });
  });
});
