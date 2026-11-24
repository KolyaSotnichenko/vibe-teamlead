import { describe, expect, it } from 'vitest';

import { approvedState, commentedState, designSkipNote, ownerSkippedState, parseCompare } from '../task-design';

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

  it("keeps why QA could not show a frame in the running app, for the owner", () => {
    const compare = parseCompare(JSON.stringify({ screens: [{ file: 'screens/card.html', width: 1280, notShown: '  The conflict state needs two devices  ' }] }));
    expect(compare?.screens[0]).toEqual({ file: 'screens/card.html', width: 1280, notShown: 'The conflict state needs two devices', differences: [] });
  });
});

describe('a design the designer could not make', () => {
  const now = new Date('2026-11-18T10:00:00Z');

  it("building without it is the owner's decision, recorded with the reason", () => {
    expect(ownerSkippedState(undefined, 'Rate limit reached', now)).toEqual({
      stage: 'skipped',
      round: 0,
      skipped: { by: 'owner', reason: 'Rate limit reached', at: '2026-11-18T10:00:00.000Z' },
    });
    const kept = ownerSkippedState({ stage: 'wireframes', round: 2, approved: { wireframes: 'a' }, comments: [{ n: 1, frame: '', text: 'x' }] }, 'cancelled', now);
    expect(kept).toMatchObject({ stage: 'skipped', round: 2, approved: { wireframes: 'a' }, skipped: { by: 'owner' } });
    expect(kept.comments).toBeUndefined();
  });

  it("says why an older design was skipped: the owner's choice, or the designer stopping (from the task's log)", () => {
    expect(designSkipNote({ stage: 'skipped', round: 0, skipped: { by: 'owner', reason: 'Rate limit reached', at: 'x' } }, undefined)).toEqual({ by: 'owner', reason: 'Rate limit reached' });
    const logs = JSON.stringify({
      phases: {
        planning: { entries: [{ content: 'Design: starting from the project\'s 273 existing frame(s) (design/base/)' }] },
        design: { entries: [{ content: 'Design: the designer stopped (Rate limit reached); building from the spec without a design' }] },
      },
    });
    expect(designSkipNote({ stage: 'skipped', round: 1 }, logs)).toEqual({ by: 'designer', reason: 'Rate limit reached' });
    // A task with no UI, or a design that was not skipped, says nothing
    expect(designSkipNote({ stage: 'skipped', round: 0 }, JSON.stringify({ phases: {} }))).toBeNull();
    expect(designSkipNote({ stage: 'design', round: 1 }, logs)).toBeNull();
    expect(designSkipNote(undefined, '{ not json')).toBeNull();
  });
});
