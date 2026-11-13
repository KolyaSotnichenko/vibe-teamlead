/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';

import { Teamlead } from '../Teamlead';
import { MOODS, TICK_MS } from '../sprite';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// F-010
describe('Teamlead', () => {
  it('plays the mood with a timer of one step per frame, not with a CSS animation', () => {
    vi.useFakeTimers();
    const { container } = render(<Teamlead mood="idle" label="Teamlead" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.style.animation).toBe('');
    expect(svg.style.transform).toBe('translateX(0%)');
    vi.advanceTimersByTime(MOODS.idle.speed * TICK_MS);
    expect(svg.style.transform).toBe(`translateX(-${100 / MOODS.idle.frames}%)`);
  });

  it('starts the new mood from its first frame', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Teamlead mood="idle" label="Teamlead" />);
    vi.advanceTimersByTime(MOODS.idle.speed * TICK_MS * 3);
    rerender(<Teamlead mood="working" label="Teamlead" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.style.transform).toBe('translateX(0%)');
    vi.advanceTimersByTime(MOODS.working.speed * TICK_MS);
    expect(svg.style.transform).toBe(`translateX(-${100 / MOODS.working.frames}%)`);
  });

  it('leaves no timer behind when it goes away', () => {
    vi.useFakeTimers();
    const { unmount } = render(<Teamlead mood="idle" label="Teamlead" />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
