/**
 * Whether a screen looks different from the last merge's picture of it: the share of pixels whose
 * colour moved by more than a small tolerance (font smoothing, anti-aliasing). Raw 4-byte pixels,
 * as Electron's NativeImage.toBitmap() gives them; the channel order doesn't matter here. Pure.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** 4 bytes per pixel */
  data: Uint8Array;
}

/** Per channel: smaller differences are rendering noise */
const TOLERANCE = 24;
/** Past this share of changed pixels a screen counts as changed */
export const CHANGED_SHARE = 0.005;

/** The share of pixels that differ (0..1); 1 when the pictures have different sizes. */
export function changedShare(a: Bitmap, b: Bitmap, tolerance = TOLERANCE): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const pixels = a.width * a.height;
  if (!pixels) return 0;
  let changed = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > tolerance ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance ||
      Math.abs(a.data[i + 3] - b.data[i + 3]) > tolerance
    ) {
      changed++;
    }
  }
  return changed / pixels;
}

export function isChanged(a: Bitmap, b: Bitmap): boolean {
  return changedShare(a, b) > CHANGED_SHARE;
}
