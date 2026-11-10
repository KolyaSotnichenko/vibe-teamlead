import { describe, expect, it } from 'vitest';

import { approvedState, commentedState, parseCompare } from '../task-design';

describe("the owner's answer on the Design tab", () => {
  it('approving marks the stage the build stopped at, and clears comments', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(approvedState({ stage: 'wireframes', round: 1, comments: [] }, 'wireframes', now)).toEqual({ stage: 'wireframes', round: 1, approved: { wireframes: '2026-11-10T12:00:00.000Z' } });
    expect(approvedState({ stage: 'design', round: 2, approved: { wireframes: 'a' } }, 'design', now)?.approved).toEqual({ wireframes: 'a', design: '2026-11-10T12:00:00.000Z' });
    // Only the stage it waits at
    expect(approvedState({ stage: 'wireframes', round: 1 }, 'design', now)).toBeNull();
    expect(approvedState(undefined, 'wireframes', now)).toBeNull();
  });

  it('comments are kept as data: numbered, trimmed, on known frames, at most 40', () => {
    const state = commentedState({ stage: 'wireframes', round: 1 }, [
      { frame: 'wireframes/roadmap.html', selector: 'main > section:nth-of-type(2)', x: 120.4, y: 88, text: '  Votes on every card  ' },
      { frame: 'wireframes/roadmap.html', text: '' },
      { frame: '../../etc/passwd', text: 'x' },
      { frame: '', text: 'On the whole set: calmer' },
    ], ['wireframes/roadmap.html']);
    expect(state?.comments).toEqual([
      { n: 1, frame: 'wireframes/roadmap.html', selector: 'main > section:nth-of-type(2)', x: 120, y: 88, text: 'Votes on every card' },
      { n: 2, frame: '', text: 'On the whole set: calmer' },
    ]);
    expect(commentedState({ stage: 'design', round: 2 }, [], ['x'])).toBeNull();
  });

  it("reads QA's comparison, dropping anything malformed", () => {
    const compare = parseCompare(JSON.stringify({ screens: [
      { file: 'screens/roadmap-phone.html', width: 390, built: 'qa/roadmap-390.png', differences: [{ severity: 'blocking', text: 'No stage tabs' }, { severity: 'loud', text: 'x' }] },
      { nope: true },
    ] }));
    expect(compare).toEqual({ screens: [{ file: 'screens/roadmap-phone.html', width: 390, built: 'qa/roadmap-390.png', differences: [{ severity: 'blocking', text: 'No stage tabs' }, { severity: 'minor', text: 'x' }] }] });
    expect(parseCompare('not json')).toBeNull();
  });
});
