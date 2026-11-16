import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Resource {
  from: string;
  to: string;
  filter?: string[];
}

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
  build: {
    files: string[];
    asarUnpack?: string[];
    extraResources: Resource[];
    dmg?: { size?: string };
    afterAllArtifactBuild?: string;
    mac?: { extraResources?: Resource[]; artifactName?: string };
    win?: { target?: unknown; icon?: string; artifactName?: string; extraResources?: Resource[] };
    nsis?: Record<string, unknown>;
  };
};
const build = pkg.build;
const targets = (resources: Resource[] | undefined) => (resources ?? []).map((entry) => entry.to);

describe('what ships in the app', () => {
  // Sized automatically, the volume once came out too small: it dropped the framework, the build
  // succeeded, and the released app crashed on launch.
  it('sets the DMG volume size, and checks every DMG against the app', () => {
    expect(build.dmg?.size).toBeTruthy();
    expect(build.afterAllArtifactBuild).toBe('scripts/verify-dmg.cjs');
  });

  // resolvePackagedTools runs them from Resources. As dependencies they would ship a second time, unpacked from the asar.
  it.each([
    ['Claude Code', '!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**'],
    ['CodeGraph', '!**/node_modules/@colbymchenry/codegraph-*/**'],
  ])('%s ships once, in Resources', (_name, excluded) => {
    expect(build.files).toContain(excluded);
  });

  it('macOS ships the darwin Claude Code, CodeGraph and scanners', () => {
    const mac = build.mac?.extraResources ?? [];
    expect(mac).toContainEqual({ from: '../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude', to: 'claude-code/claude' });
    expect(mac.find((entry) => entry.to === 'codegraph')?.from).toBe('../../node_modules/@colbymchenry/codegraph-darwin-${arch}');
    expect(mac.find((entry) => entry.to === 'codegraph')?.filter).toEqual(['bin/**', 'lib/**', 'node', 'package.json', 'LICENSE*']);
    expect(mac).toContainEqual({ from: 'vendor-bin', to: 'scanners', filter: ['gitleaks', 'osv-scanner'] });
  });

  it('Windows ships claude.exe, CodeGraph with its node.exe and the .exe scanners', () => {
    const win = build.win?.extraResources ?? [];
    expect(win).toContainEqual({ from: '../../node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', to: 'claude-code/claude.exe' });
    const codegraph = win.find((entry) => entry.to === 'codegraph');
    expect(codegraph?.from).toBe('../../node_modules/@colbymchenry/codegraph-win32-x64');
    expect(codegraph?.filter).toEqual(expect.arrayContaining(['bin/**', 'lib/**', 'node.exe']));
    expect(win).toContainEqual({ from: 'vendor-bin', to: 'scanners', filter: ['gitleaks.exe', 'osv-scanner.exe'] });
  });

  it('keeps per-platform binaries out of the shared resources', () => {
    const shared = targets(build.extraResources);
    for (const to of ['claude-code/claude', 'claude-code/claude.exe', 'codegraph', 'scanners']) expect(shared).not.toContain(to);
    // Everything else (prompts, plugins, browser MCP, LSP) ships on both
    expect(shared).toEqual(expect.arrayContaining(['prompts', 'plugins/superpowers', 'browser-mcp/node_modules/@playwright/mcp', 'lsp/node_modules/typescript']));
  });

  it('unpacks node-pty (native files, conpty and its worker scripts) on every platform', () => {
    expect(build.asarUnpack).toContain('**/node_modules/@lydell/node-pty*/**');
  });
});

describe('Windows installer', () => {
  it('builds an x64 NSIS installer with the Windows icon', () => {
    expect(build.win?.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(build.win?.icon).toBe('resources/icon.ico');
  });

  // GitHub turns spaces in uploaded file names into dots, and latest.yml then names a file that isn't there.
  it('names the installer without spaces', () => {
    const name = build.win?.artifactName ?? '';
    expect(name).not.toContain(' ');
    expect(name).not.toContain('${productName}');
    expect(name).toContain('${version}');
    expect(name).toMatch(/\.\$\{ext\}$/);
  });

  it('installs per user, lets the user choose the folder and makes shortcuts', () => {
    expect(build.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    });
  });

  it('has a package:win script that fetches the Windows scanners', () => {
    expect(pkg.scripts['package:win']).toContain('fetch-scanners.cjs --platform win32');
    expect(pkg.scripts['package:win']).toContain('electron-builder --win --x64');
  });

  it('leaves the macOS artifact name as it was', () => {
    expect(build.mac?.artifactName).toBeUndefined();
  });
});
