import { describe, expect, it } from 'vitest';

import { mainWindowWebPreferences } from '../window-options';

describe('the main window', () => {
  // F-011: with throttling off a minimized window cost as much as a visible one (8.7% of a core,
  // 0.4% with it on), and the page never learned it was hidden
  it('lets Chromium throttle it while it is hidden', () => {
    const prefs = mainWindowWebPreferences('/app/preload/index.mjs');
    expect(prefs.backgroundThrottling).not.toBe(false);
  });

  it('keeps the page isolated from Node', () => {
    const prefs = mainWindowWebPreferences('/app/preload/index.mjs');
    expect(prefs).toMatchObject({ preload: '/app/preload/index.mjs', contextIsolation: true, nodeIntegration: false, spellcheck: true });
  });
});
