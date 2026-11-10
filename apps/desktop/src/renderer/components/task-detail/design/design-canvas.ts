/** The Design tab's canvas: where the frames sit, how the view pans and zooms. Pure. */

import type { TaskDesignFrame } from '../../../../shared/types';

export interface View {
  x: number;
  y: number;
  scale: number;
}

const MARGIN = 48;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2;
/** Room above a frame for its title */
export const TITLE_SPACE = 28;

export function bounds(frames: TaskDesignFrame[]): { x: number; y: number; width: number; height: number } {
  const left = Math.min(...frames.map((f) => f.x));
  const top = Math.min(...frames.map((f) => f.y - TITLE_SPACE));
  const right = Math.max(...frames.map((f) => f.x + f.width));
  const bottom = Math.max(...frames.map((f) => f.y + f.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The view that shows every frame, centred */
export function fitView(frames: TaskDesignFrame[], size: { width: number; height: number }): View {
  if (!frames.length || size.width <= 0 || size.height <= 0) return { x: 0, y: 0, scale: 1 };
  const b = bounds(frames);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((size.width - 2 * MARGIN) / b.width, (size.height - 2 * MARGIN) / b.height)));
  return {
    scale,
    x: (size.width - b.width * scale) / 2 - b.x * scale,
    y: (size.height - b.height * scale) / 2 - b.y * scale,
  };
}

/** Zoom by `factor` keeping the canvas point under `at` (view px) where it is */
export function zoomAt(view: View, at: { x: number; y: number }, factor: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const cx = (at.x - view.x) / view.scale;
  const cy = (at.y - view.y) / view.scale;
  return { scale, x: at.x - cx * scale, y: at.y - cy * scale };
}

export type FrameFilter = 'wireframes' | 'screens' | 'all';

export function visibleFrames<T extends TaskDesignFrame>(frames: T[], filter: FrameFilter): T[] {
  if (filter === 'all') return frames;
  return frames.filter((f) => (filter === 'wireframes' ? f.kind === 'wireframe' : f.kind === 'screen'));
}

/** Where a frame's page is served: vt-design:// (main process), or the browser preview's mock */
export function frameUrl(taskId: string, file: string, mock?: Record<string, string>): string {
  if (mock?.[file]) return mock[file];
  return `vt-design://task/${encodeURIComponent(taskId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
