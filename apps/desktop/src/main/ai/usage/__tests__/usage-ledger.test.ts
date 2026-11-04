import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { billingOf, projectRootFor, readProjectUsage, recordUsage, summarizeUsage, type UsageEntry } from '../usage-ledger';

const project = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vtl-usage-'));
  mkdirSync(path.join(dir, '.vibe-teamlead'));
  return dir;
};

const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  at: '2026-11-04T10:00:00.000Z',
  agentType: 'coder',
  model: 'opus',
  input: 100,
  output: 50,
  cacheRead: 800,
  cacheWrite: 50,
  costUsd: 0.25,
  billing: 'api',
  ...over,
});

describe('usage ledger', () => {
  it('attributes a task worktree to its project, and scratch folders to none', () => {
    const dir = project();
    const worktree = path.join(dir, '.vibe-teamlead', 'worktrees', 'tasks', '003-auth');
    mkdirSync(worktree, { recursive: true });
    expect(projectRootFor(worktree)).toBe(dir);
    expect(projectRootFor(dir)).toBe(dir);
    expect(projectRootFor(mkdtempSync(path.join(tmpdir(), 'vtl-scratch-')))).toBeNull();
  });

  it("records sessions from the project and its worktrees into the project's file", async () => {
    const dir = project();
    const worktree = path.join(dir, '.vibe-teamlead', 'worktrees', 'tasks', '003-auth');
    mkdirSync(worktree, { recursive: true });
    await recordUsage(worktree, entry());
    await recordUsage(dir, entry({ agentType: 'spec_writer', costUsd: 0.5 }));
    await recordUsage(dir, entry({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })); // empty: skipped

    expect(readFileSync(path.join(dir, '.vibe-teamlead', 'usage.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(2);
    const usage = await readProjectUsage(dir);
    expect(usage.sessions).toBe(2);
    expect(usage.totalTokens).toBe(2000);
    expect(usage.costUsd).toBeCloseTo(0.75);
    expect(usage.byAgent).toEqual({ coder: 1000, spec_writer: 1000 });
  });

  it('prices only Anthropic API sessions; gateway and subscription tokens are counted apart', () => {
    const lines = [
      entry({ costUsd: 1 }),
      entry({ billing: 'gateway', gateway: 'gw.metergateway.com', costUsd: 9 }),
      entry({ billing: 'subscription', costUsd: 9 }),
      'not json',
    ].map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
    const s = summarizeUsage(lines.join('\n'));
    expect(s.sessions).toBe(3);
    expect(s.costUsd).toBe(1);
    expect(s.pricedTokens).toBe(1000);
    expect(s.gatewayTokens).toBe(1000);
    expect(s.subscriptionTokens).toBe(1000);
    expect(s.gateways).toEqual(['gw.metergateway.com']);
  });

  it('tells API, gateway and subscription credentials apart', () => {
    expect(billingOf({})).toEqual({ billing: 'api' });
    expect(billingOf({ baseURL: 'https://api.anthropic.com' })).toEqual({ billing: 'api' });
    expect(billingOf({ baseURL: 'https://gw.metergateway.com/v1' })).toEqual({ billing: 'gateway', gateway: 'gw.metergateway.com' });
    expect(billingOf({ oauthToken: 't' })).toEqual({ billing: 'subscription' });
  });
});
