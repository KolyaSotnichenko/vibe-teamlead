/**
 * Tools that ship inside the Vibe Teamlead app, so users never install them:
 *
 * - Claude Code native binary (from the Agent SDK's per-platform package)
 * - Superpowers plugin (vendor/superpowers)
 * - CodeGraph CLI + MCP server (its per-platform bundle with its own Node)
 *
 * Resolved once in the main process (which knows `app.isPackaged`) and passed
 * to workers as plain paths.
 *
 * Packaged layout (electron-builder extraResources, see package.json):
 *   <Resources>/claude-code/claude
 *   <Resources>/plugins/superpowers/
 *   <Resources>/plugins/drawio/
 *   <Resources>/plugins/vibe-teamlead-skills/
 *   <Resources>/drawio-viewer/viewer-static.min.js
 *   <Resources>/codegraph/bin/codegraph
 *   <Resources>/scanners/{gitleaks,osv-scanner}
 *   <Resources>/browser-mcp/node_modules/{@playwright/mcp,playwright,playwright-core,chrome-devtools-mcp}
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

export interface BundledTools {
  /** Absolute path to the Claude Code executable */
  claudeCodeExecutable?: string;
  /** Absolute path to the Superpowers plugin root */
  superpowersDir?: string;
  /** draw.io diagram skill plugin (jgraph/drawio-mcp, Apache-2.0) */
  drawioPluginDir?: string;
  /** Vibe Teamlead house skills plugin (architecture, …) */
  vibeSkillsDir?: string;
  /** draw.io offline viewer script, used to render diagrams for review */
  drawioViewerScript?: string;
  /** Absolute path to the CodeGraph launcher */
  codegraphBin?: string;
  /** Playwright MCP entry point (@playwright/mcp cli.js) */
  playwrightMcpCli?: string;
  /** Chrome DevTools MCP entry point */
  chromeDevtoolsMcpCli?: string;
  /** Node runtime for bundled JS servers: Electron itself with ELECTRON_RUN_AS_NODE=1 */
  nodeRuntime?: string;
  /** gitleaks binary (secrets gate) */
  gitleaksBin?: string;
  /** OSV-Scanner binary (vulnerable dependency gate) */
  osvScannerBin?: string;
}

/** Find an executable on PATH (development fallback for the scanners). */
function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const PLAYWRIGHT_CLI = 'cli.js';
const DEVTOOLS_CLI = join('build', 'src', 'bin', 'chrome-devtools-mcp.js');

function platformTarget(): string {
  return `${process.platform}-${process.arch}`;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}

function resolveFromPackage(pkg: string, file: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve(`${pkg}/package.json`)), file);
  } catch {
    return undefined;
  }
}

/** Packaged app: everything lives under Contents/Resources. */
export function resolvePackagedTools(resourcesPath: string): BundledTools {
  return {
    claudeCodeExecutable: firstExisting([join(resourcesPath, 'claude-code', 'claude')]),
    superpowersDir: firstExisting([join(resourcesPath, 'plugins', 'superpowers')]),
    drawioPluginDir: firstExisting([join(resourcesPath, 'plugins', 'drawio')]),
    vibeSkillsDir: firstExisting([join(resourcesPath, 'plugins', 'vibe-teamlead-skills')]),
    drawioViewerScript: firstExisting([join(resourcesPath, 'drawio-viewer', 'viewer-static.min.js')]),
    codegraphBin: firstExisting([join(resourcesPath, 'codegraph', 'bin', 'codegraph')]),
    playwrightMcpCli: firstExisting([join(resourcesPath, 'browser-mcp', 'node_modules', '@playwright', 'mcp', PLAYWRIGHT_CLI)]),
    chromeDevtoolsMcpCli: firstExisting([join(resourcesPath, 'browser-mcp', 'node_modules', 'chrome-devtools-mcp', DEVTOOLS_CLI)]),
    nodeRuntime: process.execPath,
    gitleaksBin: firstExisting([join(resourcesPath, 'scanners', 'gitleaks')]),
    osvScannerBin: firstExisting([join(resourcesPath, 'scanners', 'osv-scanner')]),
  };
}

/** Development: resolve from node_modules and the repo's vendor/ folder. */
export function resolveDevTools(appRoot: string): BundledTools {
  const target = platformTarget();
  return {
    claudeCodeExecutable: firstExisting(
      [resolveFromPackage(`@anthropic-ai/claude-agent-sdk-${target}`, 'claude')].filter(
        (p): p is string => !!p,
      ),
    ),
    superpowersDir: firstExisting([join(appRoot, 'vendor', 'superpowers')]),
    drawioPluginDir: firstExisting([join(appRoot, 'vendor', 'drawio')]),
    vibeSkillsDir: firstExisting([join(appRoot, 'vendor', 'vibe-teamlead-skills')]),
    drawioViewerScript: firstExisting([join(appRoot, 'vendor', 'drawio-viewer', 'viewer-static.min.js')]),
    codegraphBin: firstExisting(
      [resolveFromPackage(`@colbymchenry/codegraph-${target}`, join('bin', 'codegraph'))].filter(
        (p): p is string => !!p,
      ),
    ),
    playwrightMcpCli: firstExisting(
      [resolveFromPackage('@playwright/mcp', PLAYWRIGHT_CLI)].filter((p): p is string => !!p),
    ),
    chromeDevtoolsMcpCli: firstExisting(
      [resolveFromPackage('chrome-devtools-mcp', DEVTOOLS_CLI)].filter((p): p is string => !!p),
    ),
    nodeRuntime: process.execPath,
    gitleaksBin: firstExisting([join(appRoot, 'vendor-bin', 'gitleaks')]) ?? onPath('gitleaks'),
    osvScannerBin: firstExisting([join(appRoot, 'vendor-bin', 'osv-scanner')]) ?? onPath('osv-scanner'),
  };
}

/**
 * Resolve bundled tools for the current process (main process only).
 */
export function resolveBundledTools(): BundledTools {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    if (app?.isPackaged) return resolvePackagedTools(process.resourcesPath);
    if (app) return resolveDevTools(app.getAppPath());
  } catch {
    // Not running under Electron (tests, CLI)
  }
  return resolveDevTools(process.cwd());
}
