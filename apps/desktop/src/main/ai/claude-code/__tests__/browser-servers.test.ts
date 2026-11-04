import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { cliStarts, removeBrokenBrowserServers } from '../browser-servers';

const stdio = (cli: string) => ({ type: 'stdio' as const, command: 'node', args: [cli, '--headless'], env: { X: '1' } });

describe('removeBrokenBrowserServers', () => {
  it('drops a browser server that cannot start, says so, and leaves the rest', () => {
    const servers = { playwright: stdio('pw.js'), 'chrome-devtools': stdio('cd.js'), context7: stdio('c7.js') };
    const onProblem = vi.fn();

    const kept = removeBrokenBrowserServers(servers, onProblem, (_c, cli) => cli !== 'pw.js');

    expect(Object.keys(kept)).toEqual(['chrome-devtools', 'context7']);
    expect(onProblem).toHaveBeenCalledTimes(1);
    expect(onProblem.mock.calls[0][0]).toContain('playwright');
  });

  it("checks only browser servers", () => {
    const canStart = vi.fn(() => false);
    const servers = { context7: stdio('c7.js'), 'vibe-teamlead': { type: 'sdk' } as never };
    expect(Object.keys(removeBrokenBrowserServers(servers, () => {}, canStart))).toEqual(['context7', 'vibe-teamlead']);
    expect(canStart).not.toHaveBeenCalled();
  });
});

describe('cliStarts', () => {
  const script = (body: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'vtl-cli-')), 'cli.js');
    writeFileSync(file, body);
    return file;
  };

  it('tells a working CLI from one that crashes on load', () => {
    expect(cliStarts(process.execPath, script('process.exit(0)'), {})).toBe(true);
    expect(cliStarts(process.execPath, script("require('no-such-package-here')"), {})).toBe(false);
  });

  it('a missing runtime counts as broken', () => {
    expect(cliStarts('/no/such/runtime', script('process.exit(0)'), {})).toBe(false);
  });
});

describe('what the app bundles for its browser servers', () => {
  const desktop = resolve(__dirname, '../../../../..');
  const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf-8'));
  const resources: Array<{ from: string; to: string }> = pkg.build.extraResources.filter(
    (r: { to?: string }) => r.to?.startsWith('browser-mcp/node_modules/'),
  );
  const bundled = (name: string) => {
    const entry = resources.find((r) => r.to === `browser-mcp/node_modules/${name}`);
    if (!entry) throw new Error(`${name} is not bundled`);
    return JSON.parse(readFileSync(join(desktop, entry.from, 'package.json'), 'utf-8'));
  };

  it('every bundled server gets the exact Playwright versions it asks for', () => {
    const mcp = bundled('@playwright/mcp');
    for (const dep of ['playwright', 'playwright-core']) {
      expect(bundled(dep).version, dep).toBe(mcp.dependencies[dep]);
    }
  });
});

describe('prompts', () => {
  it("don't send an agent to a browser tool the app doesn't have", () => {
    const prompt = readFileSync(resolve(__dirname, '../../../../../prompts/ideation_ui_ux.md'), 'utf-8');
    expect(prompt).not.toMatch(/puppeteer/i);
  });
});
