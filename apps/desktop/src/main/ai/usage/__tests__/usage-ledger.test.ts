import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { billingOf, configuredGatewayModels, projectRootFor, readProjectUsage, recordUsage, summarizeUsage, type UsageEntry } from '../usage-ledger';

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

describe('summarizeUsage on a gateway, with the prices the user entered', () => {
  const line = (over: Record<string, unknown>) => JSON.stringify({
    at: '2026-11-05T10:00:00.000Z', agentType: 'coder', model: 'glm-5.3-flash', billing: 'gateway', gateway: 'gw.example.com',
    input: 1_000_000, output: 100_000, cacheRead: 10_000_000, cacheWrite: 0, costUsd: 999, specId: '008-task', ...over,
  });
  const prices = { 'glm-5.3-flash': { input: 1, output: 4, cacheRead: 0.1 } };

  it('prices each kind of token per million, and ignores the figure Claude Code guessed', () => {
    const summary = summarizeUsage(line({}), prices);
    expect(summary.gatewayCostUsd).toBeCloseTo(1 + 0.4 + 1);
    expect(summary.gatewayCostKinds).toEqual({ input: 1, output: expect.closeTo(0.4), cacheRead: 1, cacheWrite: 0 });
  });

  it('gives each model its tokens and cost, most expensive first', () => {
    const summary = summarizeUsage([line({}), line({ model: 'kimi', input: 10, output: 10, cacheRead: 10 })].join('\n'), { ...prices, kimi: { input: 1, output: 1, cacheRead: 1 } });
    expect(summary.gatewayModels.map((row) => row.model)).toEqual(['glm-5.3-flash', 'kimi']);
    expect(summary.gatewayModels[0]).toMatchObject({ input: 1_000_000, output: 100_000, cacheRead: 10_000_000 });
    expect(summary.gatewayModels[0].costUsd).toBeCloseTo(2.4);
  });

  it('says a model has no price instead of counting it as free', () => {
    const summary = summarizeUsage([line({}), line({ model: 'unpriced' })].join('\n'), prices);
    expect(summary.gatewayModels.find((row) => row.model === 'unpriced')?.costUsd).toBeUndefined();
    expect(summary.gatewayCostUsd).toBeCloseTo(2.4);
    expect(summary.gatewayModelsUnpriced).toEqual(['unpriced']);
  });

  it('charges a cache write at the input price unless it has its own', () => {
    expect(summarizeUsage(line({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }), prices).gatewayCostUsd).toBeCloseTo(1);
    expect(summarizeUsage(line({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }), { 'glm-5.3-flash': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 } }).gatewayCostUsd).toBeCloseTo(2);
  });

  it('adds up what each task cost, most expensive first', () => {
    const summary = summarizeUsage([line({ specId: 'a' }), line({ specId: 'b' }), line({ specId: 'b' })].join('\n'), prices);
    expect(summary.gatewayTasks.map((task) => task.specId)).toEqual(['b', 'a']);
    expect(summary.gatewayTasks[0].costUsd).toBeCloseTo(4.8);
  });

  it("a model name from the ledger can't reach Object's prototype", () => {
    const summary = summarizeUsage(line({ model: '__proto__' }), prices);
    expect(summary.gatewayModels[0]).toMatchObject({ model: '__proto__' });
    expect(summary.gatewayModels[0].costUsd).toBeUndefined();
    expect(({} as Record<string, unknown>).input).toBeUndefined();
  });

  it('prices each session at what the model cost on its date', () => {
    const summary = summarizeUsage(
      [line({ at: '2026-11-10T00:00:00.000Z', specId: 'old', cacheRead: 0, output: 0 }), line({ at: '2026-12-10T00:00:00.000Z', specId: 'new', cacheRead: 0, output: 0 })].join('\n'),
      { 'glm-5.3-flash': [{ from: '', input: 1, output: 1, cacheRead: 1 }, { from: '2026-12-01T00:00:00.000Z', input: 5, output: 5, cacheRead: 5 }] },
    );
    expect(summary.gatewayCostUsd).toBeCloseTo(6);
    expect(summary.gatewayTasks).toEqual([{ specId: 'new', costUsd: 5 }, { specId: 'old', costUsd: 1 }]);
  });

  describe('the models set in Settings', () => {
    it('are listed before they have run, so they can get a price', () => {
      const summary = summarizeUsage(line({}), prices, ['new-model']);
      expect(summary.gatewayModels.map((row) => row.model)).toEqual(['glm-5.3-flash', 'new-model']);
      expect(summary.gatewayModels[1]).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
    });

    it("don't count as missing from the total until they have tokens", () => {
      expect(summarizeUsage(line({}), prices, ['new-model']).gatewayModelsUnpriced).toEqual([]);
    });

    it('a model no longer set stays while it has history', () => {
      expect(summarizeUsage(line({}), prices, []).gatewayModels[0].model).toBe('glm-5.3-flash');
    });

    it('are listed once', () => {
      expect(summarizeUsage(line({}), prices, ['glm-5.3-flash', 'glm-5.3-flash']).gatewayModels).toHaveLength(1);
    });
  });

  it('picks the models from the settings: only with a gateway, and no aliases', () => {
    const settings = { anthropicBaseUrl: 'https://gw.example.com', customPhaseModels: { spec: 'glm-5.3', coding: 'glm-5.3-flash' }, featureModels: { naming: 'minimax', utility: 'opus' }, subagentModel: '' };
    expect(configuredGatewayModels(settings).sort()).toEqual(['glm-5.3', 'glm-5.3-flash', 'minimax']);
    expect(configuredGatewayModels({ ...settings, anthropicBaseUrl: '' })).toEqual([]);
    expect(configuredGatewayModels(undefined)).toEqual([]);
  });

  it('leaves the Anthropic figure alone: only there is it the real price', () => {
    const summary = summarizeUsage(line({ billing: 'api', costUsd: 5 }), prices);
    expect(summary.costUsd).toBe(5);
    expect(summary.gatewayCostUsd).toBe(0);
    expect(summary.gatewayModels).toEqual([]);
  });
});
