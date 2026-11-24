import { describe, expect, it } from 'vitest';

import { visibleBounds } from '../visible-bounds';

const rect = (x: number, y: number, width: number, height: number) => ({ left: x, top: y, right: x + width, bottom: y + height, width, height });

describe('visibleBounds', () => {
  it("is the part of the page's box its scrolling ancestors and the window show", () => {
    // The task window's body scrolls; the box runs past its bottom, over the footer
    const box = rect(100, 880, 1760, 900);
    const clips = [rect(40, 680, 1900, 670), rect(30, 20, 1930, 1440)];
    expect(visibleBounds(box, clips, { width: 2000, height: 1500 })).toEqual({ x: 100, y: 880, width: 1760, height: 470 });
  });

  it('is null when nothing of the box is visible (scrolled out of sight)', () => {
    expect(visibleBounds(rect(0, 2000, 500, 300), [rect(0, 0, 800, 900)], { width: 800, height: 900 })).toBeNull();
  });

  it('is the box itself when nothing clips it', () => {
    expect(visibleBounds(rect(10, 20, 300, 200), [], { width: 800, height: 900 })).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });
});
