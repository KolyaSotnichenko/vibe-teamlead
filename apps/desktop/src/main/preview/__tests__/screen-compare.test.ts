import { describe, expect, it } from 'vitest';

import { changedShare, isChanged } from '../screen-compare';

const bitmap = (width: number, height: number, fill: [number, number, number, number] = [255, 255, 255, 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
};

describe('changedShare', () => {
  it('is 0 for the same picture and the share of pixels that differ otherwise', () => {
    const a = bitmap(10, 10);
    const b = bitmap(10, 10);
    expect(changedShare(a, b)).toBe(0);
    for (let p = 0; p < 10; p++) b.data.set([0, 0, 0, 255], p * 4);
    expect(changedShare(a, b)).toBeCloseTo(0.1);
  });

  it('ignores a small difference in colour (font smoothing), not a real one', () => {
    const a = bitmap(4, 4);
    const b = bitmap(4, 4, [250, 252, 248, 255]);
    expect(changedShare(a, b)).toBe(0);
    expect(changedShare(a, bitmap(4, 4, [200, 200, 200, 255]))).toBe(1);
  });

  it('is 1 when the page has another size: the layout moved', () => {
    expect(changedShare(bitmap(10, 10), bitmap(10, 12))).toBe(1);
  });
});

describe('isChanged', () => {
  it('counts a screen as changed past a few tenths of a percent of its pixels', () => {
    const a = bitmap(100, 100);
    const b = bitmap(100, 100);
    for (let p = 0; p < 10; p++) b.data.set([0, 0, 0, 255], p * 4);
    expect(isChanged(a, b)).toBe(false);
    for (let p = 0; p < 200; p++) b.data.set([0, 0, 0, 255], p * 4);
    expect(isChanged(a, b)).toBe(true);
  });
});
