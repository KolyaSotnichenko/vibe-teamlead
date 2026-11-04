import { describe, expect, it } from 'vitest';

import { PHRASES, phraseFor, phraseMs } from '../droid-voice';
import { countMood, SLEEP_AFTER_MS, teamleadMood, type MoodInput } from '../mood';
import { drawFrame, gridPaths, MOODS, moodStrip, SPRITE_W, TICK_MS, type TeamleadMood } from '../sprite';

const ALL = Object.keys(MOODS) as TeamleadMood[];
const quiet: MoodInput = { coding: 0, qa: 0, queued: 0, review: 0, errors: 0, waiting: 0, quietForMs: 0, justMerged: false, hello: false };

describe('sprite', () => {
  it('draws every frame of every mood, and every mood actually moves', () => {
    for (const mood of ALL) {
      const frames = Array.from({ length: MOODS[mood].frames }, (_, f) => JSON.stringify(drawFrame(mood, f)));
      expect(new Set(frames).size, mood).toBeGreaterThan(1);
    }
  });

  it('uses vermilion only for moods that need attention', () => {
    const signal = (mood: TeamleadMood) => moodStrip(mood).paths.x.length > 0;
    expect(ALL.filter(signal).sort()).toEqual(['done', 'error', 'review', 'waiting']);
  });

  it('lays frames side by side and times the strip by frames and pace', () => {
    const strip = moodStrip('working');
    expect(strip.frames).toBe(4);
    expect(strip.durationMs).toBe(4 * MOODS.working.speed * TICK_MS);
    // The last frame starts at x = 3 × 16
    expect(strip.paths.b).toMatch(new RegExp(`M${3 * SPRITE_W + 4} `));
    expect(moodStrip('working')).toBe(strip);
  });

  it('merges a run of one colour into one rectangle', () => {
    const g = drawFrame('idle', 0).map((row) => row.map(() => '.' as const));
    (g[0] as string[]).splice(2, 3, 'b', 'b', 'b');
    expect(gridPaths(g as never).b).toBe('M2 0h3v1h-3z');
  });
});

describe('mood', () => {
  it('counts errors apart from tasks to review', () => {
    expect(
      countMood([
        { status: 'in_progress' },
        { status: 'ai_review' },
        { status: 'queue' },
        { status: 'human_review', reviewReason: 'completed' },
        { status: 'human_review', reviewReason: 'errors' },
        { status: 'error' },
        { status: 'done' },
      ]),
    ).toEqual({ coding: 1, qa: 1, queued: 1, review: 1, errors: 2 });
  });

  it('picks one mood by priority', () => {
    const busy = { ...quiet, coding: 1, qa: 1, queued: 1, review: 1, errors: 1, waiting: 1 };
    expect(teamleadMood({ ...busy, hello: true, justMerged: true })).toBe('hello');
    expect(teamleadMood({ ...busy, justMerged: true })).toBe('done');
    expect(teamleadMood(busy)).toBe('error');
    expect(teamleadMood({ ...busy, errors: 0 })).toBe('waiting');
    expect(teamleadMood({ ...busy, errors: 0, waiting: 0 })).toBe('review');
    expect(teamleadMood({ ...quiet, coding: 1, qa: 1, queued: 1 })).toBe('working');
    expect(teamleadMood({ ...quiet, qa: 1, queued: 1 })).toBe('qa');
    expect(teamleadMood({ ...quiet, queued: 1 })).toBe('queued');
    expect(teamleadMood(quiet)).toBe('idle');
    expect(teamleadMood({ ...quiet, quietForMs: SLEEP_AFTER_MS })).toBe('sleep');
    // Queued work keeps him awake
    expect(teamleadMood({ ...quiet, queued: 1, quietForMs: SLEEP_AFTER_MS })).toBe('queued');
  });
});

describe('droid voice', () => {
  it('is silent on the first mood and on no change', () => {
    expect(phraseFor(null, 'waiting')).toBeNull();
    expect(phraseFor('waiting', 'waiting')).toBeNull();
  });

  it('speaks for moods worth hearing', () => {
    expect(phraseFor('working', 'waiting')).toBe('question');
    expect(phraseFor('qa', 'review')).toBe('pleased');
    expect(phraseFor('qa', 'error')).toBe('sad');
    expect(phraseFor('review', 'done')).toBe('laugh');
    expect(phraseFor('idle', 'hello')).toBe('hello');
    expect(phraseFor('idle', 'sleep')).toBe('yawn');
  });

  it('greets the start of work only after rest, and says nothing on calming down', () => {
    expect(phraseFor('idle', 'working')).toBe('start');
    expect(phraseFor('qa', 'working')).toBeNull();
    expect(phraseFor('queued', 'qa')).toBe('think');
    expect(phraseFor('working', 'idle')).toBeNull();
    expect(phraseFor('working', 'queued')).toBeNull();
  });

  it('keeps phrases short', () => {
    for (const phrase of Object.keys(PHRASES) as Array<keyof typeof PHRASES>) {
      expect(phraseMs(phrase), phrase).toBeLessThan(800);
    }
  });
});
