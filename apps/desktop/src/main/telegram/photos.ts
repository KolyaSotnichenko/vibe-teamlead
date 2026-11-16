/**
 * A picture made fit for Telegram's sendPhoto / sendMediaGroup: at most 1600 wide, sides within
 * Telegram's limits (fitPhoto), PNG, or JPEG when the PNG is too big; nothing when it can't fit.
 * Works on Electron's NativeImage; typed structurally so tests need no Electron.
 */

import { fitPhoto } from './review-details';

/** Telegram takes photos up to 10 MB */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_RATIO = 20;

export interface ImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: { x: number; y: number; width: number; height: number }): ImageLike;
  resize(options: { width?: number; height?: number }): ImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

export function toTelegramPhoto(source: ImageLike): Buffer | undefined {
  if (source.isEmpty()) return undefined;
  const { width, height } = source.getSize();
  if (!width || !height) return undefined;
  let image = source;
  let size = { width, height };
  // Too tall for Telegram: the top part, at the most it takes
  if (height / width > MAX_RATIO) {
    size = { width, height: width * MAX_RATIO };
    image = image.crop({ x: 0, y: 0, ...size });
  }
  const fit = fitPhoto(size.width, size.height);
  if (fit.width !== size.width || fit.height !== size.height) image = image.resize({ width: fit.width, height: fit.height });
  const png = image.toPNG();
  if (png.length <= MAX_PHOTO_BYTES) return png;
  const jpeg = image.toJPEG(85);
  return jpeg.length <= MAX_PHOTO_BYTES ? jpeg : undefined;
}
