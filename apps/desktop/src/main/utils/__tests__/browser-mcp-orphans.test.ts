import { describe, expect, it } from 'vitest';

import { orphanedBrowserTrees, parsePs } from '../browser-mcp-orphans';

const CLI = '/Applications/Vibe Teamlead.app/Contents/Resources/browser-mcp/node_modules/@playwright/mcp/cli.js';
const DEVTOOLS = '/Applications/Vibe Teamlead.app/Contents/Resources/browser-mcp/node_modules/chrome-devtools-mcp/build/src/index.js';

const ps = [
  // An orphaned Playwright MCP (its Claude Code session is gone) and the Chrome it started
  `  501     1 /Applications/Vibe Teamlead.app/Contents/Frameworks/Vibe Teamlead Helper.app/Contents/MacOS/Vibe Teamlead Helper ${CLI} --headless --isolated`,
  '  502   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --user-data-dir=/var/folders/x/playwright_chromiumdev_profile-AbC',
  '  503   502 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper --type=renderer',
  // A live one: its parent (claude) still runs
  '  600   599 /path/claude --output-format stream-json',
  `  601   600 node ${CLI} --headless --isolated`,
  '  602   601 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless',
  // An orphaned chrome-devtools-mcp of ours
  `  700     1 node ${DEVTOOLS} --isolated`,
  // Someone else's Playwright, orphaned too: not ours
  '  800     1 node /Users/nick/Desktop/roadmaply/node_modules/@playwright/mcp/cli.js',
  // The user's own Chrome
  '  900     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].join('\n');

describe('orphaned browser servers of the app', () => {
  it('reads ps output', () => {
    expect(parsePs(ps)[1]).toEqual({ pid: 502, ppid: 501, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --user-data-dir=/var/folders/x/playwright_chromiumdev_profile-AbC' });
  });

  it("picks only the app's own servers whose session is gone, with the browsers they started", () => {
    expect(orphanedBrowserTrees(parsePs(ps), [CLI, DEVTOOLS])).toEqual([501, 502, 503, 700]);
  });

  it('nothing without the bundled paths', () => {
    expect(orphanedBrowserTrees(parsePs(ps), [])).toEqual([]);
  });
});
