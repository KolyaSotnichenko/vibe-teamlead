import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { DesignFrame } from '../design-step';
import { checkVisualEvidence, designFileRef, planDesignFiles, requiredFrames, taskEvidenceFrames } from '../visual-evidence';

const frame = (file: string, width: number, kind: 'screen' | 'wireframe' = 'screen'): DesignFrame => ({
  file,
  width,
  kind,
  title: file,
  height: 900,
  x: 0,
  y: 0,
});

const SINCE = Date.parse('2026-11-24T10:00:00Z');

let specDir: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A screenshot under qa-browser/, taken at `at` */
function shot(name: string, at = SINCE + 60_000, bytes: Buffer | string = Buffer.concat([PNG, Buffer.from(name)])): string {
  const file = path.join(specDir, 'qa-browser', name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  utimesSync(file, new Date(at), new Date(at));
  return `qa-browser/${name}`;
}

function compare(screens: unknown[]): void {
  writeFileSync(path.join(specDir, 'design_compare.json'), JSON.stringify({ screens }));
}

const check = (frames: DesignFrame[], browser = true) => checkVisualEvidence({ specDir, frames: requiredFrames(frames), since: SINCE, browser });

beforeEach(() => {
  specDir = mkdtempSync(path.join(tmpdir(), 'vt-evidence-'));
});

describe('requiredFrames', () => {
  it('is every screen at each width it is drawn at, once', () => {
    const frames = [frame('screens/board.html', 1280), frame('screens/board.html', 390), frame('screens/board.html', 1280), frame('wireframes/board.html', 1280, 'wireframe')];
    expect(requiredFrames(frames)).toEqual([
      { file: 'screens/board.html', width: 1280 },
      { file: 'screens/board.html', width: 390 },
    ]);
  });

  it('is the wireframes when the design has no screens', () => {
    expect(requiredFrames([frame('wireframes/board.html', 1280, 'wireframe')])).toEqual([{ file: 'wireframes/board.html', width: 1280 }]);
  });
});

describe('checkVisualEvidence', () => {
  const frames = [frame('screens/board.html', 1280), frame('screens/card.html', 1280)];

  it('accepts a screenshot of the running app for every frame', () => {
    compare([
      { file: 'screens/board.html', width: 1280, built: shot('board.png'), differences: [] },
      { file: 'screens/card.html', width: 1280, built: shot('card.png'), differences: [{ severity: 'minor', text: 'radius' }] },
    ]);
    expect(check(frames)).toEqual({ problems: [], notShown: [] });
  });

  it('refuses without design_compare.json, or with no screens in it', () => {
    expect(check(frames).problems.join('\n')).toMatch(/design_compare\.json/);
    compare([]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/2 frame\(s\): screens\/board\.html at 1280 px; screens\/card\.html at 1280 px/)]);
  });

  it('names each frame that has no entry', () => {
    compare([{ file: 'screens/board.html', width: 1280, built: shot('board.png') }]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/screens\/card\.html at 1280 px/)]);
  });

  it('refuses a screenshot that is missing, outside qa-browser, older than the code, or not an image', () => {
    writeFileSync(path.join(specDir, 'elsewhere.png'), 'png');
    compare([
      { file: 'screens/board.html', width: 1280, built: 'qa-browser/none.png' },
      { file: 'screens/card.html', width: 1280, built: 'elsewhere.png' },
    ]);
    expect(check(frames).problems).toHaveLength(2);

    compare([
      { file: 'screens/board.html', width: 1280, built: shot('old.png', SINCE - 1000) },
      { file: 'screens/card.html', width: 1280, built: shot('notes.txt') },
    ]);
    const problems = check(frames).problems;
    expect(problems[0]).toMatch(/before the last commit/);
    expect(problems[1]).toMatch(/not an image/);
  });

  it('refuses a file that is not really an image, a link to elsewhere, and one screenshot used for two frames', () => {
    compare([
      { file: 'screens/board.html', width: 1280, built: shot('board.png', SINCE + 60_000, 'not a picture') },
      { file: 'screens/card.html', width: 1280, built: shot('card.png') },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/board\.png is not an image/)]);

    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'vt-outside-')), 'x.png');
    writeFileSync(outside, PNG);
    symlinkSync(outside, path.join(specDir, 'qa-browser', 'link.png'));
    compare([
      { file: 'screens/board.html', width: 1280, built: 'qa-browser/link.png' },
      { file: 'screens/card.html', width: 1280, built: shot('card.png') },
    ]);
    expect(check(frames).problems).toHaveLength(1);

    compare([
      { file: 'screens/board.html', width: 1280, built: shot('same.png') },
      { file: 'screens/card.html', width: 1280, built: 'qa-browser/same.png' },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/same\.png is already the screenshot of screens\/board\.html/)]);
  });

  it('refuses screenshots when qa-browser itself is a link to elsewhere, and one picture under two names', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'vt-elsewhere-'));
    writeFileSync(path.join(elsewhere, 'board.png'), PNG);
    writeFileSync(path.join(elsewhere, 'card.png'), PNG);
    rmSync(path.join(specDir, 'qa-browser'), { recursive: true, force: true });
    symlinkSync(elsewhere, path.join(specDir, 'qa-browser'));
    compare([
      { file: 'screens/board.html', width: 1280, built: 'qa-browser/board.png' },
      { file: 'screens/card.html', width: 1280, built: 'qa-browser/card.png' },
    ]);
    expect(check(frames).problems).toHaveLength(2);

    rmSync(path.join(specDir, 'qa-browser'));
    const first = shot('one.png');
    linkSync(path.join(specDir, first), path.join(specDir, 'qa-browser', 'two.png'));
    compare([
      { file: 'screens/board.html', width: 1280, built: first },
      { file: 'screens/card.html', width: 1280, built: 'qa-browser/two.png' },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/already the screenshot of screens\/board\.html/)]);

    // A copy under another name is the same picture too
    compare([
      { file: 'screens/board.html', width: 1280, built: shot('a.png', SINCE + 60_000, PNG) },
      { file: 'screens/card.html', width: 1280, built: shot('b.png', SINCE + 60_000, PNG) },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/already the screenshot of screens\/board\.html/)]);
  });

  it('refuses a path that climbs out of the spec directory', () => {
    compare([
      { file: 'screens/board.html', width: 1280, built: '../qa-browser/board.png' },
      { file: 'screens/card.html', width: 1280, built: shot('card.png') },
    ]);
    expect(check(frames).problems).toHaveLength(1);
  });

  it('takes a frame not shown in the app with its reason, and lists it for the owner', () => {
    compare([
      { file: 'screens/board.html', width: 1280, built: shot('board.png') },
      { file: 'screens/card.html', width: 1280, notShown: 'The conflict state needs two devices' },
    ]);
    expect(check(frames)).toEqual({ problems: [], notShown: [{ file: 'screens/card.html', width: 1280, reason: 'The conflict state needs two devices' }] });
  });

  it('refuses an entry with neither a screenshot nor a reason', () => {
    compare([
      { file: 'screens/board.html', width: 1280, built: shot('board.png') },
      { file: 'screens/card.html', width: 1280, notShown: '  ' },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/screens\/card\.html at 1280 px/)]);
  });

  it('needs at least one screen seen in the app when the session has a browser', () => {
    compare([
      { file: 'screens/board.html', width: 1280, notShown: 'needs a database' },
      { file: 'screens/card.html', width: 1280, notShown: 'needs sign-in' },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/No screen was opened in the running app/)]);
    // Without a browser the reasons are all there can be; the owner sees them
    expect(check(frames, false)).toEqual({ problems: [], notShown: expect.arrayContaining([expect.objectContaining({ file: 'screens/board.html' })]) });
  });

  it('refuses an approval with a blocking difference', () => {
    compare([
      { file: 'screens/board.html', width: 1280, built: shot('board.png'), differences: [{ severity: 'blocking', text: 'Columns are stacked, not side by side' }] },
      { file: 'screens/card.html', width: 1280, built: shot('card.png') },
    ]);
    expect(check(frames).problems).toEqual([expect.stringMatching(/blocking difference.*Columns are stacked/)]);
  });

  it('asks for nothing when the task has no design', () => {
    expect(check([])).toEqual({ problems: [], notShown: [] });
  });
});

describe('taskEvidenceFrames', () => {
  function design(state: Record<string, unknown> | null, frames: Array<{ file: string; width: number; kind: string }>) {
    const dir = path.join(specDir, 'design');
    for (const f of frames) {
      mkdirSync(path.join(dir, path.dirname(f.file)), { recursive: true });
      writeFileSync(path.join(dir, f.file), '<!doctype html><title>x</title>');
    }
    writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({ frames: frames.map((f) => ({ ...f, title: f.file, height: 900, x: 0, y: 0 })) }));
    if (state) writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  }

  it("is the frames of the task's design", () => {
    design({ round: 2, stage: 'design' }, [{ file: 'screens/board.html', width: 1280, kind: 'screen' }]);
    expect(taskEvidenceFrames(specDir)).toEqual([{ file: 'screens/board.html', width: 1280 }]);
  });

  it('is nothing for a skipped design, or a task with none', () => {
    expect(taskEvidenceFrames(specDir)).toEqual([]);
    design({ round: 1, stage: 'skipped' }, [{ file: 'screens/board.html', width: 1280, kind: 'screen' }]);
    expect(taskEvidenceFrames(specDir)).toEqual([]);
  });
});

describe('the design files a plan names', () => {
  it('are read as paths under design/, however the planner wrote them; anything else is dropped', () => {
    expect(designFileRef('design/base/screens/plan-board.html')).toBe('base/screens/plan-board.html');
    expect(designFileRef('base/wireframes/plan-board.html')).toBe('base/wireframes/plan-board.html');
    expect(designFileRef('screens/card.html')).toBe('screens/card.html');
    expect(designFileRef('/abs/.vibe-teamlead/specs/037-x/design/base/screens/gantt.html')).toBe('base/screens/gantt.html');
    expect(designFileRef('design/base/screens/../../../secret.html')).toBeNull();
    expect(designFileRef('apps/web/src/App.tsx')).toBeNull();
    expect(designFileRef(42)).toBeNull();
  });

  it("are every subtask's design_files, once", () => {
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify({
      phases: [
        { subtasks: [{ id: 'a', design_files: ['design/base/screens/plan-board.html', 'screens/card.html'] }] },
        { subtasks: [{ id: 'b', design_files: ['design/base/screens/plan-board.html', 'nope.txt'] }, { id: 'c' }] },
      ],
    }));
    expect(planDesignFiles(specDir)).toEqual(['base/screens/plan-board.html', 'screens/card.html']);
  });

  it("make QA show the library screens the plan rebuilds too, at the widths the library draws them", () => {
    const dir = path.join(specDir, 'design');
    mkdirSync(path.join(dir, 'screens'), { recursive: true });
    mkdirSync(path.join(dir, 'base', 'screens'), { recursive: true });
    for (const f of ['screens/admin.html', 'base/screens/plan-board.html', 'base/screens/gantt.html']) writeFileSync(path.join(dir, f), '<!doctype html>');
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ round: 2, stage: 'design' }));
    writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({ frames: [{ file: 'screens/admin.html', title: 'a', kind: 'screen', width: 1280, height: 900, x: 0, y: 0 }] }));
    writeFileSync(path.join(dir, 'base', 'canvas.json'), JSON.stringify({ frames: [
      { file: 'screens/plan-board.html', title: 'b', kind: 'screen', width: 1280, height: 900, x: 0, y: 0 },
      { file: 'screens/plan-board.html', title: 'b', kind: 'screen', width: 390, height: 900, x: 0, y: 0 },
    ] }));
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify({
      phases: [{ subtasks: [{ id: 'a', design_files: ['design/base/screens/plan-board.html', 'design/base/screens/gantt.html', 'design/base/screens/missing.html'] }] }],
    }));
    expect(taskEvidenceFrames(specDir)).toEqual([
      { file: 'screens/admin.html', width: 1280 },
      { file: 'base/screens/plan-board.html', width: 1280 },
      { file: 'base/screens/plan-board.html', width: 390 },
      { file: 'base/screens/gantt.html', width: 1280 },
    ]);
  });
});

describe('screens changed outside the task', () => {
  const frames = [frame('screens/roles.html', 1280)];
  const changed = [{ id: 'screens/my-tasks.html', width: 1280 }];
  const withRegressions = (regressions: unknown[]) =>
    compare([{ file: 'screens/roles.html', width: 1280, built: shot('roles.png') }].concat([]), regressions);
  function compare(screens: unknown[], regressions: unknown[]): void {
    writeFileSync(path.join(specDir, 'design_compare.json'), JSON.stringify({ screens, regressions }));
  }
  const check = () => checkVisualEvidence({ specDir, frames: requiredFrames(frames), since: SINCE, browser: true, changed });

  it('need a verdict each: expected, with why', () => {
    withRegressions([]);
    expect(check().problems).toEqual([expect.stringMatching(/screens\/my-tasks\.html at 1280 px.*changed/)]);
    withRegressions([{ id: 'screens/my-tasks.html', width: 1280, verdict: 'expected', why: 'The task restyled the shared filter button' }]);
    expect(check()).toEqual({ problems: [], notShown: [], expected: [{ id: 'screens/my-tasks.html', width: 1280, why: 'The task restyled the shared filter button' }] });
  });

  it('a regression is a reason to reject, not to approve', () => {
    withRegressions([{ id: 'screens/my-tasks.html', width: 1280, verdict: 'regression', why: 'The list lost its group headers' }]);
    expect(check().problems).toEqual([expect.stringMatching(/regression.*reject/i)]);
  });

  it('an expected change needs its reason', () => {
    withRegressions([{ id: 'screens/my-tasks.html', width: 1280, verdict: 'expected' }]);
    expect(check().problems).toHaveLength(1);
  });

  it('are asked for even when the task has no design of its own', () => {
    withRegressions([]);
    expect(checkVisualEvidence({ specDir, frames: [], since: SINCE, browser: true, changed }).problems).toHaveLength(1);
  });
});
