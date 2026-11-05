/**
 * Language servers for agent sessions. Claude Code loads LSP servers from a
 * plugin's `.lsp.json` (`{ <name>: { command, args, extensionToLanguage, … } }`)
 * and then gives the agent the LSP tool (definitions, references, hover) and
 * diagnostics after each edit, so type errors arrive without a tsc run.
 *
 * TypeScript/JavaScript (typescript-language-server + typescript) and Python
 * (pyright) ship with the app and run on the Node that CodeGraph bundles.
 * Go (gopls), Rust (rust-analyzer) and C/C++ (clangd) are used only when the
 * machine has them on PATH. Which servers a session gets follows the
 * project's languages: project_index.json when it exists, else a scan for
 * package.json, pyproject.toml, go.mod and Cargo.toml. Pure except the scan;
 * no Electron.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One server as Claude Code's `.lsp.json` declares it. */
export interface LspServerSpec {
  name: string;
  command: string;
  args: string[];
  extensionToLanguage: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

/** The bundled pieces (from bundled-tools.ts) the registry needs. */
export interface LspBundled {
  /** Node binary (CodeGraph's) that runs the bundled JS servers */
  lspNode?: string;
  /** typescript-language-server's lib/cli.mjs */
  typescriptLanguageServer?: string;
  /** typescript's lib folder (tsserver.js), the server's fallback when the project has no typescript */
  typescriptLib?: string;
  /** pyright's langserver.index.js */
  pyrightLangserver?: string;
}

export interface LspSelection {
  servers: LspServerSpec[];
  /** Languages without a server, each with the reason */
  missing: string[];
}

const TS_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
};

/** Servers used from PATH, by registry key. */
const PATH_SERVERS: Record<string, { name: string; bin: string; extensionToLanguage: Record<string, string> }> = {
  go: { name: 'go', bin: 'gopls', extensionToLanguage: { '.go': 'go' } },
  rust: { name: 'rust', bin: 'rust-analyzer', extensionToLanguage: { '.rs': 'rust' } },
  c: { name: 'c', bin: 'clangd', extensionToLanguage: { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp' } },
};

/** Registry key for a language name as project_index.json spells it (or close). */
function registryKey(language: string): string | undefined {
  const l = language.trim().toLowerCase();
  if (l === 'typescript' || l === 'javascript' || l === 'node' || l === 'node.js') return 'typescript';
  if (l === 'python') return 'python';
  if (l === 'go' || l === 'golang') return 'go';
  if (l === 'rust') return 'rust';
  if (l === 'c' || l === 'c++' || l === 'cpp') return 'c';
  return undefined;
}

/** The servers for these languages, with the bundled pieces and what is on PATH. */
export function lspServersFor(languages: string[], bundled: LspBundled, onPath: (name: string) => string | undefined): LspSelection {
  const servers: LspServerSpec[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const language of languages) {
    const key = registryKey(language);
    if (!key) {
      missing.push(`${language} (no language server)`);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === 'typescript') {
      if (bundled.lspNode && bundled.typescriptLanguageServer) {
        servers.push({
          name: 'typescript',
          command: bundled.lspNode,
          args: [bundled.typescriptLanguageServer, '--stdio'],
          extensionToLanguage: { ...TS_EXTENSIONS },
          ...(bundled.typescriptLib ? { initializationOptions: { tsserver: { fallbackPath: bundled.typescriptLib } } } : {}),
        });
      } else missing.push(`${language} (bundled server not found)`);
    } else if (key === 'python') {
      if (bundled.lspNode && bundled.pyrightLangserver) {
        servers.push({ name: 'python', command: bundled.lspNode, args: [bundled.pyrightLangserver, '--stdio'], extensionToLanguage: { '.py': 'python', '.pyi': 'python' } });
      } else missing.push(`${language} (bundled server not found)`);
    } else {
      const spec = PATH_SERVERS[key];
      const bin = onPath(spec.bin);
      if (bin) servers.push({ name: spec.name, command: bin, args: [], extensionToLanguage: { ...spec.extensionToLanguage } });
      else missing.push(`${language} (${spec.bin} is not installed)`);
    }
  }
  return { servers, missing };
}

export interface LspManifest {
  /** .claude-plugin/plugin.json */
  pluginJson: { name: string; description: string; version: string; author: { name: string }; license: string };
  /** .lsp.json at the plugin root */
  lspJson: Record<string, Omit<LspServerSpec, 'name'>>;
}

/** The two files of the generated plugin. Pure. */
export function lspManifest(servers: LspServerSpec[]): LspManifest {
  const lspJson: LspManifest['lspJson'] = {};
  for (const { name, ...rest } of servers) lspJson[name] = rest;
  return {
    pluginJson: {
      name: 'vibe-teamlead-lsp',
      description: `Language servers for this project, declared by Vibe Teamlead: ${servers.map((s) => s.name).join(', ')}`,
      version: '1.0.0',
      author: { name: 'Vibe Teamlead' },
      license: 'AGPL-3.0',
    },
    lspJson,
  };
}

/** The languages project_index.json names for its services, sorted and unique. Pure. */
export function languagesFromIndex(index: Record<string, unknown>): string[] {
  const services = index.services;
  if (!services || typeof services !== 'object') return [];
  const languages = new Set<string>();
  for (const service of Object.values(services as Record<string, unknown>)) {
    const language = (service as { language?: unknown } | null)?.language;
    if (typeof language === 'string' && language) languages.add(language);
  }
  return [...languages].sort();
}

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '.vibe-teamlead', 'vendor', '.next', 'coverage']);

/** Languages by manifest files in the root, its folders and their folders (monorepos). */
export function scanProjectLanguages(projectDir: string): string[] {
  const languages = new Set<string>();
  const inspect = (dir: string) => {
    if (existsSync(join(dir, 'package.json'))) languages.add(existsSync(join(dir, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript');
    if (['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].some((f) => existsSync(join(dir, f)))) languages.add('Python');
    if (existsSync(join(dir, 'go.mod'))) languages.add('Go');
    if (existsSync(join(dir, 'Cargo.toml'))) languages.add('Rust');
    if (existsSync(join(dir, 'CMakeLists.txt')) || existsSync(join(dir, 'compile_commands.json'))) languages.add('C++');
  };
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name))
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };
  if (!existsSync(projectDir)) return [];
  inspect(projectDir);
  for (const level1 of subdirs(projectDir)) {
    inspect(level1);
    for (const level2 of subdirs(level1)) inspect(level2);
  }
  return [...languages].sort();
}

/** One task-log line. Pure. */
export function lspLogLine(selection: LspSelection): string {
  const names = selection.servers.map((s) => s.name).join(', ');
  if (selection.servers.length && selection.missing.length) return `LSP: ${names}; none for ${selection.missing.join(', ')}`;
  if (selection.servers.length) return `LSP: ${names}`;
  if (selection.missing.length) return `LSP: none (no server for ${selection.missing.join(', ')})`;
  return 'LSP: none (no language detected)';
}
