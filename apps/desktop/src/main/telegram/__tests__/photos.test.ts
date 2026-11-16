import { describe, expect, it } from 'vitest';

import { type ImageLike, MAX_PHOTO_BYTES, toTelegramPhoto } from '../photos';

function image(width: number, height: number, bytes = 100, log: string[] = []): ImageLike {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    crop: (rect) => {
      log.push(`crop ${rect.width}x${rect.height}`);
      return image(rect.width, rect.height, bytes, log);
    },
    resize: (size) => {
      log.push(`resize ${size.width}x${size.height}`);
      return image(size.width ?? width, size.height ?? height, bytes, log);
    },
    toPNG: () => Buffer.alloc(bytes, 1),
    toJPEG: () => Buffer.alloc(Math.floor(bytes / 4), 2),
  };
}

describe('toTelegramPhoto', () => {
  it('sends a small picture as it is, as PNG', () => {
    const log: string[] = [];
    expect(toTelegramPhoto(image(1280, 900, 100, log))?.length).toBe(100);
    expect(log).toEqual([]);
  });

  it('resizes a wide one and crops a very tall one', () => {
    const log: string[] = [];
    toTelegramPhoto(image(3200, 2000, 100, log));
    expect(log).toEqual(['resize 1600x1000']);
    const tall: string[] = [];
    toTelegramPhoto(image(200, 8000, 100, tall));
    expect(tall).toEqual(['crop 200x4000']);
    const huge: string[] = [];
    toTelegramPhoto(image(2000, 80000, 100, huge));
    expect(huge).toEqual(['crop 2000x40000', 'resize 400x8000']);
  });

  it('a PNG over the limit goes as JPEG; still too big or empty: nothing', () => {
    expect(toTelegramPhoto(image(1000, 1000, MAX_PHOTO_BYTES + 4))?.[0]).toBe(2);
    expect(toTelegramPhoto(image(1000, 1000, MAX_PHOTO_BYTES * 8))).toBeUndefined();
    expect(toTelegramPhoto(image(0, 0))).toBeUndefined();
  });
});
