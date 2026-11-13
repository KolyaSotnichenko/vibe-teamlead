import { describe, expect, it } from 'vitest';

import { playStrip, type StripClock } from '../play-strip';

function clock(over: Partial<{ hidden: boolean; reducedMotion: boolean }> = {}) {
  const state = { hidden: false, reducedMotion: false, ...over };
  let tick: (() => void) | undefined;
  let visibility: (() => void) | undefined;
  const started: number[] = [];
  let stops = 0;
  const env: StripClock = {
    hidden: () => state.hidden,
    reducedMotion: () => state.reducedMotion,
    every: (ms, fn) => { started.push(ms); tick = fn; return () => { tick = undefined; stops += 1; }; },
    onVisibility: (fn) => { visibility = fn; return () => { visibility = undefined; }; },
  };
  return {
    env, state, started,
    tick: () => tick?.(),
    running: () => tick !== undefined,
    listening: () => visibility !== undefined,
    setHidden: (hidden: boolean) => { state.hidden = hidden; visibility?.(); },
    stops: () => stops,
  };
}
const strip = () => ({ style: { transform: '' } });

// F-010: the CSS steps() animation made Chromium work on every screen frame for a picture that changes 2 to 5 times a second
describe('playStrip', () => {
  it('shows the first frame, then moves one frame per step and wraps around', () => {
    const el = strip();
    const c = clock();
    playStrip(el, 4, 400, c.env);
    expect(el.style.transform).toBe('translateX(0%)');
    expect(c.started).toEqual([400]);
    c.tick();
    expect(el.style.transform).toBe('translateX(-25%)');
    c.tick();
    c.tick();
    expect(el.style.transform).toBe('translateX(-75%)');
    c.tick();
    expect(el.style.transform).toBe('translateX(0%)');
  });

  it('does not run a timer while the window is hidden, and goes on from the same frame when it shows again', () => {
    const el = strip();
    const c = clock({ hidden: true });
    playStrip(el, 4, 400, c.env);
    expect(c.running()).toBe(false);
    c.setHidden(false);
    expect(c.running()).toBe(true);
    c.tick();
    expect(el.style.transform).toBe('translateX(-25%)');
    c.setHidden(true);
    expect(c.running()).toBe(false);
    c.setHidden(false);
    c.tick();
    expect(el.style.transform).toBe('translateX(-50%)');
  });

  it('stays on the first frame for people who asked for reduced motion', () => {
    const el = strip();
    const c = clock({ reducedMotion: true });
    playStrip(el, 4, 400, c.env);
    expect(el.style.transform).toBe('translateX(0%)');
    expect(c.running()).toBe(false);
    c.setHidden(false);
    expect(c.running()).toBe(false);
  });

  it('a single frame needs no timer', () => {
    const c = clock();
    playStrip(strip(), 1, 400, c.env);
    expect(c.running()).toBe(false);
  });

  it('stops the timer and stops listening when asked', () => {
    const c = clock();
    const stop = playStrip(strip(), 4, 400, c.env);
    stop();
    expect(c.running()).toBe(false);
    expect(c.listening()).toBe(false);
    c.setHidden(false);
    expect(c.running()).toBe(false);
  });
});
