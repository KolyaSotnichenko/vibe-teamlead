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
 *   <Resources>/plugins/frontend-design/
 *   <Resources>/plugins/ux-review/
 *   <Resources>/plugins/gsap-skills/
 *   <Resources>/drawio-viewer/viewer-static.min.js
 *   <Resources>/codegraph/bin/codegraph
 *   <Resources>/scanners/{gitleaks,osv-scanner}
 *
 * Semgrep is not bundled (a Python package): it is used only when found on PATH.
 *   <Resources>/browser-mcp/node_modules/{@playwright/mcp,playwright,playwright-core,chrome-devtools-mcp}
 *   <Resources>/lsp/node_modules/{typescript-language-server,typescript,pyright}  (run on codegraph/node)
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { findOnPath } from '../../platform/exec';

export interface BundledTools {
  /** Absolute path to the Claude Code executable */
  claudeCodeExecutable?: string;
  /** Absolute path to the Superpowers plugin root */
  superpowersDir?: string;
  /** draw.io diagram skill plugin (jgraph/drawio-mcp, Apache-2.0) */
  drawioPluginDir?: string;
  /** Vibe Teamlead house skills plugin (architecture, …) */
  vibeSkillsDir?: string;
  /** Anthropic's frontend-design skill (anthropics/skills, Apache-2.0), for UI subtasks */
  frontendDesignDir?: string;
  /** The UX review skill (vendor/ux-review), for the QA reviewer of tasks that change UI */
  uxReviewDir?: string;
  /** GreenSock's GSAP skills (vendor/gsap-skills, MIT), for the designer and UI coders that animate */
  gsapSkillsDir?: string;
  /** draw.io offline viewer script, used to render diagrams for review */
  drawioViewerScript?: string;
  /** mermaid.min.js, to check and render .mmd diagrams for the architect */
  mermaidScript?: string;
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
  /** Semgrep, when installed on this machine (static analysis gate); never bundled */
  semgrepBin?: string;
  /** Node binary that runs the bundled language servers (CodeGraph's own) */
  lspNode?: string;
  /** typescript-language-server entry point (lib/cli.mjs) */
  typescriptLanguageServer?: string;
  /** typescript's lib folder: the server's fallback tsserver when the project has no typescript */
  typescriptLib?: string;
  /** pyright language server entry point (langserver.index.js) */
  pyrightLangserver?: string;
}

const PLAYWRIGHT_CLI = 'cli.js';
const DEVTOOLS_CLI = join('build', 'src', 'bin', 'chrome-devtools-mcp.js');
const TS_SERVER_CLI = join('lib', 'cli.mjs');
const PYRIGHT_SERVER = 'langserver.index.js';

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
    frontendDesignDir: firstExisting([join(resourcesPath, 'plugins', 'frontend-design')]),
    uxReviewDir: firstExisting([join(resourcesPath, 'plugins', 'ux-review')]),
    gsapSkillsDir: firstExisting([join(resourcesPath, 'plugins', 'gsap-skills')]),
    drawioViewerScript: firstExisting([join(resourcesPath, 'drawio-viewer', 'viewer-static.min.js')]),
    mermaidScript: firstExisting([join(resourcesPath, 'mermaid', 'mermaid.min.js')]),
    codegraphBin: firstExisting([join(resourcesPath, 'codegraph', 'bin', 'codegraph')]),
    playwrightMcpCli: firstExisting([join(resourcesPath, 'browser-mcp', 'node_modules', '@playwright', 'mcp', PLAYWRIGHT_CLI)]),
    chromeDevtoolsMcpCli: firstExisting([join(resourcesPath, 'browser-mcp', 'node_modules', 'chrome-devtools-mcp', DEVTOOLS_CLI)]),
    nodeRuntime: process.execPath,
    gitleaksBin: firstExisting([join(resourcesPath, 'scanners', 'gitleaks')]),
    osvScannerBin: firstExisting([join(resourcesPath, 'scanners', 'osv-scanner')]),
    semgrepBin: findOnPath('semgrep'),
    lspNode: firstExisting([join(resourcesPath, 'codegraph', 'node')]),
    typescriptLanguageServer: firstExisting([join(resourcesPath, 'lsp', 'node_modules', 'typescript-language-server', TS_SERVER_CLI)]),
    typescriptLib: firstExisting([join(resourcesPath, 'lsp', 'node_modules', 'typescript', 'lib')]),
    pyrightLangserver: firstExisting([join(resourcesPath, 'lsp', 'node_modules', 'pyright', PYRIGHT_SERVER)]),
  };
}

const defined = (p: string | undefined): p is string => !!p;

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
    frontendDesignDir: firstExisting([join(appRoot, 'vendor', 'frontend-design')]),
    uxReviewDir: firstExisting([join(appRoot, 'vendor', 'ux-review')]),
    gsapSkillsDir: firstExisting([join(appRoot, 'vendor', 'gsap-skills')]),
    drawioViewerScript: firstExisting([join(appRoot, 'vendor', 'drawio-viewer', 'viewer-static.min.js')]),
    mermaidScript: firstExisting(
      [resolveFromPackage('mermaid', join('dist', 'mermaid.min.js'))].filter((p): p is string => !!p),
    ),
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
    gitleaksBin: firstExisting([join(appRoot, 'vendor-bin', 'gitleaks')]) ?? findOnPath('gitleaks'),
    osvScannerBin: firstExisting([join(appRoot, 'vendor-bin', 'osv-scanner')]) ?? findOnPath('osv-scanner'),
    semgrepBin: findOnPath('semgrep'),
    lspNode: firstExisting([resolveFromPackage(`@colbymchenry/codegraph-${target}`, 'node')].filter(defined)),
    typescriptLanguageServer: firstExisting([resolveFromPackage('typescript-language-server', TS_SERVER_CLI)].filter(defined)),
    typescriptLib: firstExisting([resolveFromPackage('typescript', 'lib')].filter(defined)),
    pyrightLangserver: firstExisting([resolveFromPackage('pyright', PYRIGHT_SERVER)].filter(defined)),
  };
}

/** What a worker thread was handed by the main process (it can't load Electron to find them) */
let registered: BundledTools | undefined;

export function setDefaultBundledTools(tools: BundledTools | undefined): void {
  registered = tools;
}

/**
 * Resolve bundled tools for the current process: the ones registered (a worker thread), else
 * from Electron's app paths (main process).
 */
export function resolveBundledTools(): BundledTools {
  if (registered) return registered;
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

/** The bundled browser servers' entry files: how their processes are told apart from anyone else's */
export function bundledBrowserServers(): Array<string | undefined> {
  const tools = resolveBundledTools();
  return [tools.playwrightMcpCli, tools.chromeDevtoolsMcpCli];
}
