/**
 * The pixel teamlead ("Lead"): a 16×18 sprite drawn from rectangles, one strip
 * of frames per mood. Each strip is four SVG paths (one per colour), built once
 * and cached; the component animates the strip with a CSS steps() transform,
 * so the running app spends no JS on it. Pure — tested directly.
 */

export type TeamleadMood =
  | 'idle'
  | 'working'
  | 'qa'
  | 'queued'
  | 'waiting'
  | 'review'
  | 'error'
  | 'done'
  | 'sleep'
  | 'hello';

/** b body (light), s shade, d detail (the surface colour), x signal */
export type PixelColor = 'b' | 's' | 'd' | 'x';
type Cell = PixelColor | '.';
type Grid = Cell[][];

export const SPRITE_W = 16;
export const SPRITE_H = 18;
/** Milliseconds per animation tick; a mood's frame lasts `speed` ticks. */
export const TICK_MS = 200;

/** Frames and pace per mood. */
export const MOODS: Record<TeamleadMood, { frames: number; speed: number }> = {
  idle: { frames: 8, speed: 3 },
  working: { frames: 4, speed: 1 },
  qa: { frames: 4, speed: 2 },
  queued: { frames: 4, speed: 3 },
  waiting: { frames: 4, speed: 2 },
  review: { frames: 4, speed: 2 },
  error: { frames: 6, speed: 1 },
  done: { frames: 6, speed: 1 },
  sleep: { frames: 6, speed: 3 },
  hello: { frames: 4, speed: 1 },
};

// The body is drawn two rows down, leaving room for jumps and marks above the head
const Y0 = 2;
const EYE_Y = 4;
const EYES = [6, 9];
const MOUTH_Y = 6;
const ARM_Y = 10;
const ARM_H = 3;
const ARM_X = { left: 3, right: 12 } as const;

function blank(): Grid {
  return Array.from({ length: SPRITE_H }, () => Array<Cell>(SPRITE_W).fill('.'));
}

function rect(g: Grid, c: Cell, x: number, y: number, w = 1, h = 1): void {
  for (let j = y + Y0; j < y + Y0 + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (i >= 0 && i < SPRITE_W && j >= 0 && j < SPRITE_H) g[j][i] = c;
    }
  }
}

type Draw = (c: Cell, x: number, y: number, w?: number, h?: number) => void;
type ArmPose = 'down' | 'up' | 'wave' | 'type' | 'hold' | 'head';

function body(D: Draw, Dl: Draw): void {
  // Head with the bottom corners cut, headphones (band + cups), collar, hoodie, legs
  D('b', 4, 1, 8, 7);
  D('.', 4, 7);
  D('.', 11, 7);
  D('s', 5, 0, 6, 1);
  D('s', 4, 1);
  D('s', 11, 1);
  D('s', 3, 2, 1, 4);
  D('s', 12, 2, 1, 4);
  D('s', 5, 8, 6, 1);
  D('b', 4, 9, 8, 5);
  D('d', 6, 12, 4, 1);
  Dl('s', 5, 14, 2, 2);
  Dl('s', 9, 14, 2, 2);
}

function arm(D: Draw, side: -1 | 1, pose: ArmPose, f: number): void {
  const x = side < 0 ? ARM_X.left : ARM_X.right;
  if (pose === 'down') D('b', x, ARM_Y, 1, ARM_H);
  else if (pose === 'up') D('b', x, ARM_Y - ARM_H, 1, ARM_H);
  else if (pose === 'wave') {
    if (f % 2) D('b', x + side, ARM_Y - ARM_H - 1, 1, ARM_H);
    else D('b', x, ARM_Y - ARM_H, 1, ARM_H);
  } else if (pose === 'type') {
    D('b', x, ARM_Y, 1, 2);
    // Hands on the laptop lid, pressing in turn
    D('b', x - 2 * side, ARM_Y + 2 - ((f + (side > 0 ? 1 : 0)) % 2));
  } else if (pose === 'hold') D('b', x, ARM_Y, 1, 2);
  else if (pose === 'head') D('b', x, ARM_Y - ARM_H - (f % 2), 1, ARM_H + (f % 2));
}

function eyes(D: Draw, mode: 'open' | 'low' | 'closed' | 'happy', look = 0): void {
  EYES.forEach((ex, i) => {
    const x = ex + look;
    if (mode === 'open') D('d', x, EYE_Y, 1, 2);
    else if (mode === 'low') D('d', x, EYE_Y + 1);
    else if (mode === 'closed') D('d', i ? x : x - 1, EYE_Y + 1, 2, 1);
    else {
      D('d', x, EYE_Y);
      D('d', i ? x + 1 : x - 1, EYE_Y + 1);
    }
  });
}

function mouth(D: Draw, mode: 'smile' | 'wavy'): void {
  if (mode === 'smile') D('d', 7, MOUTH_Y, 2, 1);
  else {
    D('d', 6, MOUTH_Y + 1);
    D('d', 7, MOUTH_Y);
    D('d', 8, MOUTH_Y + 1);
    D('d', 9, MOUTH_Y);
  }
}

function zee(g: Grid, x: number, y: number): void {
  rect(g, 'b', x, y, 3, 1);
  rect(g, 'b', x + 1, y + 1);
  rect(g, 'b', x, y + 2, 3, 1);
}

/** One frame of a mood as a pixel grid. */
export function drawFrame(mood: TeamleadMood, f: number): Grid {
  const g = blank();
  let dx = 0;
  let dy = 0;
  let legsDy = 0;
  if (mood === 'done') {
    dy = [0, -1, -2, -2, -1, 0][f] ?? 0;
    legsDy = dy;
  }
  if (mood === 'error') dx = [1, -1, 0, 0, 0, 0][f] ?? 0;
  if (mood === 'sleep') dy = [0, 0, 0, 1, 1, 1][f] ?? 0;
  const D: Draw = (c, x, y, w, h) => rect(g, c, x + dx, y + dy, w, h);
  const Dl: Draw = (c, x, y, w, h) => rect(g, c, x + dx, y + legsDy, w, h);
  body(D, Dl);

  switch (mood) {
    case 'idle':
      eyes(D, f === 2 ? 'low' : 'open', [0, 0, 0, 1, 1, 0, -1, 0][f] ?? 0);
      arm(D, -1, 'down', f);
      arm(D, 1, 'down', f);
      break;
    case 'working':
      eyes(D, 'low');
      // Laptop: lid seen from behind, then the base
      D('s', 5, 10, 6, 3);
      D('s', 4, 13, 8, 1);
      arm(D, -1, 'type', f);
      arm(D, 1, 'type', f);
      break;
    case 'qa': {
      const cx = [5, 7, 9, 7][f] ?? 7;
      eyes(D, 'open', cx < 7 ? -1 : cx > 7 ? 1 : 0);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (i || j) D('s', cx + i, 11 + j);
      D('s', cx + 2, 13);
      arm(D, -1, 'down', f);
      arm(D, 1, 'hold', f);
      break;
    }
    case 'queued':
      eyes(D, f === 3 ? 'low' : 'open', [0, 1, 1, 0][f] ?? 0);
      arm(D, -1, 'down', f);
      arm(D, 1, 'down', f);
      // Hourglass beside him, the sand falling through
      rect(g, 's', 13, 9, 3, 1);
      rect(g, 's', 13, 13, 3, 1);
      rect(g, 's', 13, 10);
      rect(g, 's', 15, 10);
      rect(g, 's', 13, 12);
      rect(g, 's', 15, 12);
      rect(g, 'b', 14, [10, 11, 12, 12][f] ?? 10);
      break;
    case 'waiting':
    case 'hello':
      eyes(D, f === 3 ? 'low' : 'open');
      if (mood === 'hello') mouth(D, 'smile');
      arm(D, -1, 'down', f);
      arm(D, 1, 'wave', f);
      if (mood === 'waiting') {
        // "?"
        rect(g, 'x', 13, 0, 3, 1);
        rect(g, 'x', 15, 1);
        rect(g, 'x', 14, 2, 2, 1);
        rect(g, 'x', 14, 4);
      }
      break;
    case 'review': {
      const o = f % 2 ? -1 : 0;
      eyes(D, 'happy');
      mouth(D, 'smile');
      arm(D, -1, 'down', f);
      D('b', 12, 5, 1, 5);
      // A sheet held up, with a check
      rect(g, 'b', 13, o, 3, 5);
      rect(g, 'x', 13, 2 + o);
      rect(g, 'x', 14, 3 + o);
      rect(g, 'x', 15, 2 + o);
      rect(g, 'x', 15, 1 + o);
      break;
    }
    case 'error':
      eyes(D, 'low');
      mouth(D, 'wavy');
      arm(D, -1, 'down', f);
      arm(D, 1, 'head', f);
      // "!"
      rect(g, 'x', 14, 0, 1, 3);
      rect(g, 'x', 14, 4);
      break;
    case 'done':
      eyes(D, 'happy');
      mouth(D, 'smile');
      arm(D, -1, 'up', f);
      arm(D, 1, 'up', f);
      for (const [x, y, c] of [
        [0, 0, 'x'],
        [14, 1, 'b'],
        [1, 4, 's'],
        [15, 5, 'x'],
        [2, -2, 'b'],
        [13, -1, 's'],
      ] as const) {
        rect(g, c, x, ((y + f + 2) % 8) - 2);
      }
      break;
    case 'sleep': {
      eyes(D, 'closed');
      arm(D, -1, 'down', f);
      arm(D, 1, 'down', f);
      const path = [
        [13, 2],
        [13, 0],
        [13, -2],
      ];
      for (const step of [f, (f + 3) % 6]) if (step < 3) zee(g, path[step][0], path[step][1]);
      break;
    }
  }
  return g;
}

export type StripPaths = Record<PixelColor, string>;

/** A grid as one path per colour; `offsetX` places it within a strip. */
export function gridPaths(g: Grid, offsetX = 0, out: StripPaths = { b: '', s: '', d: '', x: '' }): StripPaths {
  for (let y = 0; y < SPRITE_H; y++) {
    let x = 0;
    while (x < SPRITE_W) {
      const c = g[y][x];
      if (c === '.') {
        x++;
        continue;
      }
      let n = 1;
      while (x + n < SPRITE_W && g[y][x + n] === c) n++;
      out[c] += `M${x + offsetX} ${y}h${n}v1h-${n}z`;
      x += n;
    }
  }
  return out;
}

export interface MoodStrip {
  frames: number;
  durationMs: number;
  paths: StripPaths;
}

const strips = new Map<TeamleadMood, MoodStrip>();

/** Every frame of a mood side by side, cached. */
export function moodStrip(mood: TeamleadMood): MoodStrip {
  const cached = strips.get(mood);
  if (cached) return cached;
  const { frames, speed } = MOODS[mood];
  const paths: StripPaths = { b: '', s: '', d: '', x: '' };
  for (let f = 0; f < frames; f++) gridPaths(drawFrame(mood, f), f * SPRITE_W, paths);
  const strip = { frames, durationMs: frames * speed * TICK_MS, paths };
  strips.set(mood, strip);
  return strip;
}
