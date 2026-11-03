/**
 * CodeGraph integration: a code knowledge graph agents query over MCP instead
 * of grepping through files.
 *
 * Each worktree gets its own index (`.codegraph/` inside it, excluded from
 * git). The MCP server runs with a file watcher, so the graph follows the
 * agents' edits during the session.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** MCP key → tools appear as mcp__codegraph__* */
export const CODEGRAPH_SERVER_KEY = 'codegraph';

const INDEX_DIR = '.codegraph';
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;

export function codegraphEnv(): Record<string, string> {
  const env: Record<string, string> = {
    CODEGRAPH_TELEMETRY: '0',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
    CODEGRAPH_NO_PROMPT_HOOK: '1',
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export function codegraphMcpServer(bin: string, projectDir: string): McpStdioServerConfig {
  return {
    type: 'stdio',
    command: bin,
    args: ['serve', '--mcp', '--path', projectDir],
    env: codegraphEnv(),
  };
}

/** Keep `.codegraph/` out of commits without touching the project's .gitignore. */
export function excludeIndexFromGit(projectDir: string): void {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    const excludePath = isAbsolute(raw) ? raw : join(projectDir, raw);
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    if (current.split('\n').some((line) => line.trim() === `${INDEX_DIR}/`)) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${INDEX_DIR}/\n`);
  } catch {
    // Not a git repository — nothing to exclude from.
  }
}

const indexed = new Set<string>();

/**
 * Build the index for a project directory once per process.
 * Returns false when indexing failed; the session then runs without CodeGraph.
 */
export function ensureCodegraphIndex(bin: string, projectDir: string, log?: (line: string) => void): boolean {
  if (indexed.has(projectDir)) return true;
  excludeIndexFromGit(projectDir);
  if (existsSync(join(projectDir, INDEX_DIR))) {
    indexed.add(projectDir);
    return true;
  }
  log?.(`CodeGraph: indexing ${projectDir}`);
  const result = spawnSync(bin, ['init', '-y', projectDir], {
    cwd: projectDir,
    env: codegraphEnv(),
    encoding: 'utf-8',
    timeout: INDEX_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    log?.(`CodeGraph: indexing failed (${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`})`);
    return false;
  }
  indexed.add(projectDir);
  return true;
}
