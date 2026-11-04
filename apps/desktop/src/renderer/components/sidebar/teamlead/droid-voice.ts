/**
 * The teamlead's voice: short droid chirps synthesised with Web Audio (no
 * sound files). Each phrase is a list of tones gliding between two pitches;
 * the phrase plays once when the mood changes to one worth hearing.
 */

import type { TeamleadMood } from './sprite';

export interface Tone {
  /** Start and end pitch, Hz */
  from: number;
  to: number;
  /** Length, ms */
  ms: number;
  /** Silence after the tone, ms */
  gap?: number;
  wave?: OscillatorType;
  /** Vibrato depth, Hz (a wobble for the sad phrase) */
  wobble?: number;
  /** Relative loudness, 0..1 */
  level?: number;
}

export type Phrase = 'question' | 'pleased' | 'sad' | 'laugh' | 'hello' | 'start' | 'think' | 'yawn';

export const PHRASES: Record<Phrase, Tone[]> = {
  // "bee-doo-wee?" — rising at the end like a question
  question: [
    { from: 620, to: 940, ms: 80, gap: 20 },
    { from: 900, to: 680, ms: 70, gap: 30 },
    { from: 700, to: 1500, ms: 160 },
  ],
  // two bright upward bleeps
  pleased: [
    { from: 820, to: 1250, ms: 70, gap: 40 },
    { from: 1050, to: 1700, ms: 100 },
  ],
  // a long falling whine with a wobble
  sad: [
    { from: 980, to: 820, ms: 90, gap: 30, wave: 'triangle' },
    { from: 900, to: 260, ms: 480, wave: 'triangle', wobble: 18 },
  ],
  // "a-ha-ha-ha!" — quick chirps stepping down, then a squeak up
  laugh: [
    { from: 1500, to: 1250, ms: 60, gap: 35 },
    { from: 1400, to: 1150, ms: 60, gap: 35 },
    { from: 1300, to: 1050, ms: 60, gap: 35 },
    { from: 1200, to: 950, ms: 60, gap: 60 },
    { from: 900, to: 1900, ms: 140 },
  ],
  // "bip-bop-bweep"
  hello: [
    { from: 1000, to: 1000, ms: 55, gap: 35, wave: 'square', level: 0.6 },
    { from: 1400, to: 1400, ms: 55, gap: 35, wave: 'square', level: 0.6 },
    { from: 1150, to: 1800, ms: 110 },
  ],
  // a soft "brrp" when work begins
  start: [
    { from: 480, to: 520, ms: 45, gap: 20, level: 0.7 },
    { from: 700, to: 760, ms: 50, level: 0.7 },
  ],
  // "hmm?" — two low tones, the second leaning up
  think: [
    { from: 520, to: 500, ms: 90, gap: 40, wave: 'triangle', level: 0.7 },
    { from: 560, to: 760, ms: 130, wave: 'triangle', level: 0.7 },
  ],
  // a slow, quiet falling hum
  yawn: [{ from: 420, to: 210, ms: 600, wave: 'triangle', level: 0.5 }],
};

const ACTIVE: TeamleadMood[] = ['working', 'qa'];
const RESTING: TeamleadMood[] = ['idle', 'sleep', 'queued'];

/**
 * What to say when the mood changes, or nothing. The first mood after the
 * panel appears (or after switching projects) is silent. Pure.
 */
export function phraseFor(prev: TeamleadMood | null, next: TeamleadMood): Phrase | null {
  if (prev === null || prev === next) return null;
  switch (next) {
    case 'waiting':
      return 'question';
    case 'review':
      return 'pleased';
    case 'error':
      return 'sad';
    case 'done':
      return 'laugh';
    case 'hello':
      return 'hello';
    case 'working':
      return RESTING.includes(prev) ? 'start' : null;
    case 'qa':
      return RESTING.includes(prev) ? 'think' : null;
    case 'sleep':
      return 'yawn';
    default:
      return null;
  }
}

/** Phrase length, ms. Pure. */
export function phraseMs(phrase: Phrase): number {
  return PHRASES[phrase].reduce((sum, t) => sum + t.ms + (t.gap ?? 0), 0);
}

const VOLUME = 0.07;
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

/** Play a phrase. Silent when audio isn't available. */
export function speak(phrase: Phrase): void {
  const ctx = audio();
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = VOLUME;
  master.connect(ctx.destination);

  let at = ctx.currentTime + 0.02;
  for (const tone of PHRASES[phrase]) {
    const len = tone.ms / 1000;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = tone.wave ?? 'sine';
    osc.frequency.setValueAtTime(tone.from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(tone.to, 1), at + len);
    if (tone.wobble) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 9;
      depth.gain.value = tone.wobble;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(at);
      lfo.stop(at + len);
    }
    // Quick attack and release so tones click neither on nor off
    const peak = tone.level ?? 1;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    env.gain.setValueAtTime(peak, at + Math.max(len - 0.02, 0.009));
    env.gain.exponentialRampToValueAtTime(0.0001, at + len);
    osc.connect(env).connect(master);
    osc.start(at);
    osc.stop(at + len + 0.01);
    at += len + (tone.gap ?? 0) / 1000;
  }
  window.setTimeout(() => master.disconnect(), (at - ctx.currentTime) * 1000 + 100);
}
