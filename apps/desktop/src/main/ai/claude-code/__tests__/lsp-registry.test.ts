import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDevTools, resolvePackagedTools } from '../bundled-tools';
import { lspPluginDecision, writeLspPlugin } from '../lsp-plugin';
import {
  languagesFromIndex,
  lspLogLine,
  lspManifest,
  lspServersFor,
  scanProjectLanguages,
  type LspBundled,
  type LspServerSpec,
} from '../lsp-registry';
import { buildQueryOptions } from '../runner';
import type { SessionConfig } from '../../session/types';

const bundled: LspBundled = {
  lspNode: '/res/codegraph/node',
  typescriptLanguageServer: '/res/lsp/node_modules/typescript-language-server/lib/cli.mjs',
  typescriptLib: '/res/lsp/node_modules/typescript/lib',
  pyrightLangserver: '/res/lsp/node_modules/pyright/langserver.index.js',
};
const nothingOnPath = () => undefined;

describe('lspServersFor', () => {
  it('declares the bundled TypeScript and Python servers, run with the bundled node', () => {
    const { servers, missing } = lspServersFor(['TypeScript', 'Python'], bundled, nothingOnPath);
    expect(missing).toEqual([]);
    expect(servers).toEqual<LspServerSpec[]>([
      {
        name: 'typescript',
        command: '/res/codegraph/node',
        args: ['/res/lsp/node_modules/typescript-language-server/lib/cli.mjs', '--stdio'],
        extensionToLanguage: {
          '.ts': 'typescript',
          '.mts': 'typescript',
          '.cts': 'typescript',
          '.tsx': 'typescriptreact',
          '.js': 'javascript',
          '.mjs': 'javascript',
          '.cjs': 'javascript',
          '.jsx': 'javascriptreact',
        },
        initializationOptions: { tsserver: { fallbackPath: '/res/lsp/node_modules/typescript/lib' } },
      },
      {
        name: 'python',
        command: '/res/codegraph/node',
        args: ['/res/lsp/node_modules/pyright/langserver.index.js', '--stdio'],
        extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
      },
    ]);
  });

  it('maps JavaScript to the TypeScript server once', () => {
    const { servers } = lspServersFor(['JavaScript', 'TypeScript', 'javascript'], bundled, nothingOnPath);
    expect(servers.map((s) => s.name)).toEqual(['typescript']);
  });

  it('uses gopls, rust-analyzer and clangd only when they are on PATH, and says why not', () => {
    const none = lspServersFor(['Go', 'Rust', 'C++'], bundled, nothingOnPath);
    expect(none.servers).toEqual([]);
    expect(none.missing).toEqual(['Go (gopls is not installed)', 'Rust (rust-analyzer is not installed)', 'C++ (clangd is not installed)']);
    const onPath = (name: string) => (name === 'gopls' ? '/usr/local/bin/gopls' : undefined);
    const go = lspServersFor(['Go'], bundled, onPath);
    expect(go.servers).toEqual([{ name: 'go', command: '/usr/local/bin/gopls', args: [], extensionToLanguage: { '.go': 'go' } }]);
    expect(go.missing).toEqual([]);
  });

  it('has no server for other languages, and none for TypeScript or Python when the bundle is incomplete', () => {
    expect(lspServersFor(['Ruby'], bundled, nothingOnPath)).toEqual({ servers: [], missing: ['Ruby (no language server)'] });
    expect(lspServersFor(['TypeScript'], { ...bundled, lspNode: undefined }, nothingOnPath).missing).toEqual(['TypeScript (bundled server not found)']);
    expect(lspServersFor(['Python'], { ...bundled, pyrightLangserver: undefined }, nothingOnPath).missing).toEqual(['Python (bundled server not found)']);
    expect(lspServersFor([], bundled, nothingOnPath)).toEqual({ servers: [], missing: [] });
  });
});

describe('lspManifest', () => {
  it('is a local plugin: a manifest plus .lsp.json keyed by server name', () => {
    const { servers } = lspServersFor(['Python'], bundled, nothingOnPath);
    expect(lspManifest(servers)).toEqual({
      pluginJson: {
        name: 'vibe-teamlead-lsp',
        description: 'Language servers for this project, declared by Vibe Teamlead: python',
        version: '1.0.0',
        author: { name: 'Vibe Teamlead' },
        license: 'AGPL-3.0',
      },
      lspJson: {
        python: {
          command: '/res/codegraph/node',
          args: ['/res/lsp/node_modules/pyright/langserver.index.js', '--stdio'],
          extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
        },
      },
    });
  });
});

describe('project languages', () => {
  it('come from project_index.json services', () => {
    expect(languagesFromIndex({ services: { api: { language: 'Python' }, web: { language: 'TypeScript' }, docs: {} } })).toEqual(['Python', 'TypeScript']);
    expect(languagesFromIndex({})).toEqual([]);
    expect(languagesFromIndex({ services: 'nope' })).toEqual([]);
  });

  it('are scanned from manifests when there is no index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-lsp-'));
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'package.json'), '{}');
    writeFileSync(join(dir, 'apps', 'web', 'tsconfig.json'), '{}');
    mkdirSync(join(dir, 'services', 'api'), { recursive: true });
    writeFileSync(join(dir, 'services', 'api', 'pyproject.toml'), '');
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'go.mod'), '');
    mkdirSync(join(dir, 'tools'));
    writeFileSync(join(dir, 'tools', 'Cargo.toml'), '');
    expect(scanProjectLanguages(dir)).toEqual(['JavaScript', 'Python', 'Rust', 'TypeScript']);
    expect(scanProjectLanguages(join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('lspLogLine', () => {
  it('names the servers, or why there is none', () => {
    expect(lspLogLine({ servers: [{ name: 'typescript' }, { name: 'python' }] as LspServerSpec[], missing: [] })).toBe('LSP: typescript, python');
    expect(lspLogLine({ servers: [{ name: 'typescript' }] as LspServerSpec[], missing: ['Go (gopls is not installed)'] })).toBe('LSP: typescript; none for Go (gopls is not installed)');
    expect(lspLogLine({ servers: [], missing: ['Go (gopls is not installed)'] })).toBe('LSP: none (no server for Go (gopls is not installed))');
    expect(lspLogLine({ servers: [], missing: [] })).toBe('LSP: none (no language detected)');
  });
});

describe('writeLspPlugin', () => {
  it('writes the plugin directory under the config dir, the same path for the same servers', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'vtl-cfg-'));
    const { servers } = lspServersFor(['TypeScript'], bundled, nothingOnPath);
    const dir = writeLspPlugin(configDir, servers);
    expect(dir.startsWith(join(configDir, 'lsp-plugins'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')).name).toBe('vibe-teamlead-lsp');
    const lsp = JSON.parse(readFileSync(join(dir, '.lsp.json'), 'utf-8'));
    expect(Object.keys(lsp)).toEqual(['typescript']);
    expect(lsp.typescript.command).toBe('/res/codegraph/node');
    expect(writeLspPlugin(configDir, servers)).toBe(dir);
    expect(writeLspPlugin(configDir, lspServersFor(['Python'], bundled, nothingOnPath).servers)).not.toBe(dir);
  });
});

describe('lspPluginDecision', () => {
  it('gives language servers to the coder and the QA fixer only, and only when the setting is on', () => {
    expect(lspPluginDecision('coder', undefined)).toBe(true);
    expect(lspPluginDecision('qa_fixer', true)).toBe(true);
    expect(lspPluginDecision('coder', false)).toBe(false);
    expect(lspPluginDecision('qa_reviewer', true)).toBe(false);
    expect(lspPluginDecision('planner', true)).toBe(false);
    expect(lspPluginDecision('architect', true)).toBe(false);
  });
});

describe('bundled LSP tools', () => {
  it('resolve from the packaged Resources folder next to CodeGraph', () => {
    const res = mkdtempSync(join(tmpdir(), 'vtl-res-'));
    const touch = (...parts: string[]) => {
      mkdirSync(join(res, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(res, ...parts), '');
    };
    touch('codegraph', 'node');
    touch('lsp', 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
    touch('lsp', 'node_modules', 'typescript', 'lib', 'tsserver.js');
    touch('lsp', 'node_modules', 'pyright', 'langserver.index.js');
    const tools = resolvePackagedTools(res);
    expect(tools.lspNode).toBe(join(res, 'codegraph', 'node'));
    expect(tools.typescriptLanguageServer).toBe(join(res, 'lsp', 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'));
    expect(tools.typescriptLib).toBe(join(res, 'lsp', 'node_modules', 'typescript', 'lib'));
    expect(tools.pyrightLangserver).toBe(join(res, 'lsp', 'node_modules', 'pyright', 'langserver.index.js'));
    expect(resolvePackagedTools(mkdtempSync(join(tmpdir(), 'vtl-empty-'))).typescriptLanguageServer).toBeUndefined();
  });

  it('resolve from node_modules in development', () => {
    const tools = resolveDevTools(process.cwd());
    expect(tools.typescriptLanguageServer?.endsWith(join('typescript-language-server', 'lib', 'cli.mjs'))).toBe(true);
    expect(tools.pyrightLangserver?.endsWith(join('pyright', 'langserver.index.js'))).toBe(true);
    expect(tools.typescriptLib?.endsWith(join('typescript', 'lib'))).toBe(true);
    for (const p of [tools.typescriptLanguageServer, tools.pyrightLangserver, tools.typescriptLib, tools.lspNode]) expect(p && existsSync(p)).toBe(true);
  });
});

describe('LSP plugin in query options', () => {
  const config: SessionConfig = {
    agentType: 'coder',
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the coder.',
    initialMessages: [{ role: 'user', content: 'go' }],
    toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
    maxSteps: 10,
    specDir: '/work/spec',
    projectDir: '/work',
    bundled: {},
  };

  it('loads the generated plugin and the LSP tool when the session has one', () => {
    const options = buildQueryOptions({ ...config, lspPluginDir: '/cfg/lsp-plugins/abc' }, new AbortController());
    expect(options.plugins).toEqual([{ type: 'local', path: '/cfg/lsp-plugins/abc' }]);
    expect(options.tools).toContain('LSP');
    expect(options.env?.ENABLE_LSP_TOOL).toBe('1');
    const without = buildQueryOptions(config, new AbortController());
    expect(without.plugins).toBeUndefined();
    expect(without.tools).not.toContain('LSP');
    expect(without.env?.ENABLE_LSP_TOOL).toBeUndefined();
  });
});
