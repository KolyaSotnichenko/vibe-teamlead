import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { botText } from '../i18n';
import { criteriaCoverage, diffUrl, fitPhoto, latestScreenshots, parseNumstat, qaSummary, reviewLines } from '../review-details';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);

describe('review details', () => {
  it('counts the files changed and the lines added and removed', () => {
    expect(parseNumstat('10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n-\t-\timg.png\n')).toEqual({ files: 3, additions: 10, deletions: 7 });
    expect(parseNumstat('')).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it('acceptance criteria covered: from spec.md and the QA report', () => {
    const spec = '## Acceptance criteria\n- **AC-1** Given a user, when …\n- **AC-2** Given …\n- **AC-3** Given …\n';
    const qa = '| AC | Test | Result |\n|---|---|---|\n| AC-1 | t1 | pass |\n| AC-2 | t2 | fail |\n';
    expect(criteriaCoverage(spec, qa)).toEqual({ passed: 1, total: 3 });
    expect(criteriaCoverage('no criteria', qa)).toBeUndefined();
  });

  it('a link to the diff on GitHub', () => {
    expect(diffUrl({ owner: 'me', repo: 'shop' }, 'main', '012-login')).toBe('https://github.com/me/shop/compare/main...vibe-teamlead/012-login');
  });

  it('the lines of the review message', () => {
    const lines = reviewLines(
      {
        criteria: { passed: 4, total: 5 },
        checks: { status: 'passed', source: 'task' },
        files: { files: 7, additions: 120, deletions: 30 },
        diffUrl: 'https://github.com/me/shop/compare/main...vibe-teamlead/1',
        summary: 'All <criteria> pass & the UI matches.',
      },
      t,
    ).map(String);
    expect(lines).toEqual([
      '⚠️ Acceptance criteria: 4 of 5 pass',
      '✅ App checks: passed (the commands came from the task itself: the base had no checks)',
      '📝 Files changed: 7 (+120 −30)',
      '🔗 <a href="https://github.com/me/shop/compare/main...vibe-teamlead/1">Diff on GitHub</a>',
      '<blockquote expandable>All &lt;criteria&gt; pass &amp; the UI matches.</blockquote>',
    ]);
    expect(reviewLines({ criteria: { passed: 2, total: 2 } }, t).map(String)).toEqual(['✅ Acceptance criteria: 2 of 2 pass']);
    expect(reviewLines({ checks: { status: 'not_verified' } }, t).map(String)).toEqual(['⚠️ App checks: not verified']);
    expect(reviewLines({ checks: { status: 'regression' } }, t).map(String)).toEqual(['❌ App checks: regression']);
    expect(reviewLines({}, t)).toEqual([]);
  });

  it("the QA summary: the verdict's reason paragraph", () => {
    const report = '## Verdict\n\n**SIGN-OFF**: APPROVED\n\n**Reason**: All five criteria have tests that pass.\nThe UI matches the design.\n\n**Next Steps**:\n- Ready for merge\n';
    expect(qaSummary(report)).toBe('All five criteria have tests that pass.\nThe UI matches the design.');
    expect(qaSummary('no verdict')).toBeUndefined();
  });

  it('photos fit what Telegram takes: at most 1600 wide, sides under 10000, ratio under 20', () => {
    expect(fitPhoto(1280, 900)).toEqual({ width: 1280, height: 900 });
    expect(fitPhoto(3200, 2000)).toEqual({ width: 1600, height: 1000 });
    expect(fitPhoto(1280, 9500)).toEqual({ width: 1078, height: 8000 });
    expect(fitPhoto(200, 8000)).toEqual({ width: 200, height: 4000, crop: true });
  });
});

describe('latestScreenshots', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-shots-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the newest pictures of the QA browser folders, oldest first, at most the limit', () => {
    const shots = join(dir, 'spec', 'qa-browser');
    mkdirSync(join(shots, 'nested'), { recursive: true });
    const files = ['a.png', 'b.jpg', 'c.png', 'nested/d.jpeg'];
    files.forEach((f, i) => {
      writeFileSync(join(shots, f), 'x');
      utimesSync(join(shots, f), 1000 + i, 1000 + i);
    });
    writeFileSync(join(shots, 'notes.md'), 'x');
    expect(latestScreenshots([join(dir, 'spec'), join(dir, 'missing')], 3)).toEqual([join(shots, 'b.jpg'), join(shots, 'c.png'), join(shots, 'nested/d.jpeg')]);
    expect(latestScreenshots([join(dir, 'missing')], 3)).toEqual([]);
  });
});
