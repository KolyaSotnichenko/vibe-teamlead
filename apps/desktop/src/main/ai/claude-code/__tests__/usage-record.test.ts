import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Claude Code itself is not run: the stream ends with a result carrying usage
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      yield {
        type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 30 },
      };
    })(),
}));

import { runAgentSession } from '../runner';
import type { SessionConfig } from '../../session/types';

describe('token usage is recorded per project', () => {
  it("appends a finished session in a task worktree to its project's usage.jsonl", async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-usage-run-'));
    const worktree = path.join(project, '.vibe-teamlead', 'worktrees', 'tasks', '001-x');
    mkdirSync(worktree, { recursive: true });
    const config = {
      agentType: 'coder',
      model: 'claude-sonnet-5-5',
      auth: { apiKey: 'sk-ant-api03-test', baseURL: 'https://gw.metergateway.com' },
      systemPrompt: 'x',
      initialMessages: [{ role: 'user', content: 'go' }],
      toolContext: { cwd: worktree, projectDir: worktree, specDir: worktree, securityProfile: undefined as never },
      maxSteps: 3,
      toolsOverride: [],
      bundled: {},
    } as unknown as SessionConfig;

    await runAgentSession(config);

    const lines = readFileSync(path.join(project, '.vibe-teamlead', 'usage.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      agentType: 'coder', input: 100, output: 20, cacheRead: 300, cacheWrite: 30, costUsd: 0.42, billing: 'gateway', gateway: 'gw.metergateway.com',
    });
  });
});
