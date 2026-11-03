/**
 * CodeGraph integration: a code knowledge graph agents query over MCP instead
 * of grepping through files.
 *
 * Each worktree gets its own index (`.codegraph/` inside it, excluded from
 * git). The MCP server runs with a file watcher, so the graph follows the
 * agents' edits during the session.
 */

import { execFileSync, spawn } from 'node:child_process';
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

/** Per project directory: the indexing result (true = ready), shared by concurrent sessions. */
const indexing = new Map<string, Promise<boolean>>();

function runInit(bin: string, projectDir: string, log?: (line: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    log?.(`CodeGraph: indexing ${projectDir}`);
    const child = spawn(bin, ['init', '-y', projectDir], { cwd: projectDir, env: codegraphEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), INDEX_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      log?.(`CodeGraph: indexing failed (${error.message})`);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) log?.(`CodeGraph: indexing failed (${stderr.trim() || `exit ${code}`})`);
      resolve(code === 0);
    });
  });
}

/**
 * Index a project directory once per process (async, never blocks the event
 * loop). A failure is remembered, so later sessions don't wait for it again.
 */
export function indexProject(bin: string, projectDir: string, log?: (line: string) => void): Promise<boolean> {
  let pending = indexing.get(projectDir);
  if (!pending) {
    excludeIndexFromGit(projectDir);
    pending = existsSync(join(projectDir, INDEX_DIR)) ? Promise.resolve(true) : runInit(bin, projectDir, log);
    indexing.set(projectDir, pending);
  }
  return pending;
}

/**
 * Whether CodeGraph can be attached to a session now.
 * - `wait: true` (pipeline agents in the worker): wait for indexing, unless aborted.
 * - `wait: false` (main-process utility tasks): start indexing in the background
 *   and attach only if it is already done.
 */
export async function ensureCodegraphIndex(
  bin: string,
  projectDir: string,
  options: { wait: boolean; signal?: AbortSignal; log?: (line: string) => void },
): Promise<boolean> {
  const pending = indexProject(bin, projectDir, options.log);
  if (!options.wait) {
    const ready = await Promise.race([pending, Promise.resolve(undefined)]);
    return ready === true;
  }
  if (options.signal?.aborted) return false;
  const aborted = new Promise<false>((resolve) => options.signal?.addEventListener('abort', () => resolve(false), { once: true }));
  return Promise.race([pending, aborted]);
}

/** Test helper */
export function resetCodegraphIndexCache(): void {
  indexing.clear();
}
