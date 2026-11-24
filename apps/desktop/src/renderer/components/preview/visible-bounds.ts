/**
 * Where the preview's view goes: the part of the page's box that is actually on screen. The view is
 * a native layer drawn above the app's page, so nothing in the page clips it: a box that runs past
 * the bottom of a scrolling dialog (the task's window) put the preview over the dialog's footer and
 * past its edge. Pure.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box cut to each clipping ancestor's rect and to the window; null when none of it shows. */
export function visibleBounds(box: Rect, clips: Rect[], window: { width: number; height: number }): ViewBounds | null {
  let left = box.left;
  let top = box.top;
  let right = box.left + box.width;
  let bottom = box.top + box.height;
  for (const clip of [...clips, { left: 0, top: 0, width: window.width, height: window.height }]) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.left + clip.width);
    bottom = Math.min(bottom, clip.top + clip.height);
  }
  const width = Math.round(right) - Math.round(left);
  const height = Math.round(bottom) - Math.round(top);
  return width > 0 && height > 0 ? { x: Math.round(left), y: Math.round(top), width, height } : null;
}

const CLIPS = new Set(['hidden', 'auto', 'scroll', 'clip', 'overlay']);

/** The rects of the ancestors that clip what they hold (overflow hidden, auto, scroll, clip). */
export function clippingRects(element: Element): Rect[] {
  const rects: Rect[] = [];
  for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (CLIPS.has(style.overflowX) || CLIPS.has(style.overflowY)) rects.push(node.getBoundingClientRect());
  }
  return rects;
}
