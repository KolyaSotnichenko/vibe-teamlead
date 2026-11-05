import { describe, expect, it } from 'vitest';

import { taskTouchesUi, uiChangedSince } from '../qa-browser-scope';

describe('taskTouchesUi', () => {
  it('is true when any changed file is a UI file', () => {
    expect(taskTouchesUi(['src/api/users.ts', 'src/components/Button.tsx'])).toBe(true);
    expect(taskTouchesUi(['src/styles/app.css'])).toBe(true);
    expect(taskTouchesUi(['apps/web/pages/index.vue', 'README.md'])).toBe(true);
  });

  it('is false for backend, config, test and documentation changes', () => {
    expect(taskTouchesUi(['src/api/users.ts', 'src/api/__tests__/users.test.ts', 'package.json', 'docs/api.md', 'prisma/schema.prisma'])).toBe(false);
    expect(taskTouchesUi([])).toBe(false);
  });
});

describe('uiChangedSince', () => {
  it('is undefined when the changed files cannot be listed, so the browser stays on', async () => {
    expect(await uiChangedSince(async () => undefined)).toBeUndefined();
    expect(await uiChangedSince(async () => ['src/App.tsx'])).toBe(true);
    expect(await uiChangedSince(async () => ['src/server.ts'])).toBe(false);
  });
});
