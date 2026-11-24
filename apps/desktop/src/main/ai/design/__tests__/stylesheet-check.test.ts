import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkDesignStylesheets, unloadedStylesheets } from '../stylesheet-check';

const BUNDLE = 'body { font-family: var(--font-sans); }\n.mhp-btn { height: 48px; }\n';
const TOKENS = ':root { --font-sans: "Proxima Nova"; }\n';
const sheets = [
  { path: '.vibe-teamlead/design/package/mhp/components/bundle.css', content: BUNDLE },
  { path: '.vibe-teamlead/design/package/mhp/tokens.css', content: TOKENS },
];

describe('unloadedStylesheets', () => {
  it("finds the design system's stylesheet the app never loads, as it was in one project", () => {
    const files = [
      { path: 'packages/design-system/components/bundle.css', text: BUNDLE },
      { path: 'packages/design-system/tokens.css', text: TOKENS },
      // Listed in a package's files, but nothing imports it
      { path: 'packages/design-system/package.json', text: '{"files":["components/bundle.css"],"exports":{"./tokens.css":"./tokens.css"}}' },
      { path: 'apps/web/src/main.tsx', text: 'import "@mhp/design-system/tokens.css";\nimport "./styles/global.css";\n' },
    ];
    const findings = unloadedStylesheets(sheets, files);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'stylesheet-not-loaded', file: '.vibe-teamlead/design/package/mhp/components/bundle.css', match: 'bundle.css' });
    expect(findings[0].message).toMatch(/not loaded/);
  });

  it('counts an import, a CSS @import, a <link> or a require, of the file or of a copy of it under another name', () => {
    const loaded = (text: string, extra: Array<{ path: string; text: string }> = []) =>
      unloadedStylesheets([sheets[0]], [{ path: 'src/entry', text }, ...extra]);
    expect(loaded("import '@acme/ds/components/bundle.css';")).toEqual([]);
    expect(loaded('@import url("../ds/bundle.css");')).toEqual([]);
    expect(loaded('<link rel="stylesheet" href="/ds/bundle.css">')).toEqual([]);
    expect(loaded("require('./bundle.css')")).toEqual([]);
    expect(loaded("import './vendor/components.css';", [{ path: 'src/vendor/components.css', text: BUNDLE.replace(/\n/g, '\n\n') }])).toEqual([]);
    expect(loaded('// bundle.css is loaded elsewhere')).toHaveLength(1);
  });

  it('says nothing without stylesheets in the package', () => {
    expect(unloadedStylesheets([], [{ path: 'src/main.ts', text: '' }])).toEqual([]);
  });
});

describe('checkDesignStylesheets', () => {
  it("reads the package's stylesheets and the project's tracked files, not its own copy under .vibe-teamlead", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vt-sheets-'));
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    };
    write(sheets[0].path, BUNDLE);
    write(sheets[1].path, TOKENS);
    write('src/main.ts', "import './tokens.css';\n");
    write('src/tokens.css', TOKENS);
    // The app's notes about the package mention it; that is not the app loading it
    write('.vibe-teamlead/design-system.md', "import '../bundle.css'");
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });

    const findings = await checkDesignStylesheets(dir, { componentCss: sheets[0].path, tokensCss: sheets[1].path });

    expect(findings.map((f) => f.match)).toEqual(['bundle.css']);
  });

  it('says nothing for a package without stylesheets, or one that cannot be read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vt-sheets-none-'));
    expect(await checkDesignStylesheets(dir, {})).toEqual([]);
    expect(await checkDesignStylesheets(dir, { componentCss: 'missing.css' })).toEqual([]);
  });
});
