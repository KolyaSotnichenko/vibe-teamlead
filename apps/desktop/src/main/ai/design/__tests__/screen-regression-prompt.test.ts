import { describe, expect, it } from 'vitest';

import { screenCheckSection } from '../screen-regression-prompt';

describe("QA's section about the project's other screens", () => {
  it('lists each changed screen with its two pictures and asks for a verdict in design_compare.json', () => {
    const text = screenCheckSection({
      changed: [{ id: 'screens/my-tasks.html', width: 1280, before: '/s/regression/before/a.png', after: '/s/regression/after/a.png' }],
      unchanged: 12,
      added: [],
      failed: [{ id: 'screens/gantt.html', width: 1280, error: 'not found: "#gantt"' }],
    });
    expect(text).toContain('screens/my-tasks.html at 1280 px');
    expect(text).toContain('/s/regression/before/a.png');
    expect(text).toContain('/s/regression/after/a.png');
    expect(text).toContain('"regressions"');
    expect(text).toMatch(/"expected"/);
    expect(text).toMatch(/"regression"/);
    expect(text).toContain('screens/gantt.html at 1280 px');
    expect(text).toContain('screens.json');
  });

  it('says nothing when nothing changed and nothing failed', () => {
    expect(screenCheckSection({ changed: [], unchanged: 3, added: [], failed: [] })).toBe('');
    expect(screenCheckSection(undefined)).toBe('');
  });
});
