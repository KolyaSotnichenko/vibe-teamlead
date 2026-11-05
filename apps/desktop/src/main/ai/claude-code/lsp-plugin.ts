/**
 * The generated LSP plugin: a directory under the app's Claude Code config
 * dir with `.claude-plugin/plugin.json` and `.lsp.json`, passed to coder and
 * QA fixer sessions as a local plugin. One directory per set of servers
 * (content-addressed), rewritten only when its content changes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lspManifest, type LspServerSpec } from './lsp-registry';

/** Agents that edit code: the reviewer reads and reports, so it gets no server. */
const LSP_AGENTS = new Set(['coder', 'qa_fixer']);

/** Does this session get language servers? Pure. */
export function lspPluginDecision(agentType: string, lspEnabled: boolean | undefined): boolean {
  return lspEnabled !== false && LSP_AGENTS.has(agentType);
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) return;
  writeFileSync(path, content, 'utf-8');
}

/** Write the plugin for these servers under `<configDir>/lsp-plugins/<hash>` and return its path. */
export function writeLspPlugin(configDir: string, servers: LspServerSpec[]): string {
  const manifest = lspManifest(servers);
  const lspJson = JSON.stringify(manifest.lspJson, null, 2);
  const dir = join(configDir, 'lsp-plugins', createHash('sha1').update(lspJson).digest('hex').slice(0, 12));
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeIfChanged(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest.pluginJson, null, 2));
  writeIfChanged(join(dir, '.lsp.json'), lspJson);
  return dir;
}
