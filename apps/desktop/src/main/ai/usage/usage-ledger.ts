/**
 * Token usage per project.
 *
 * Every Claude Code session (pipeline agents in the worker, utility tasks in
 * the main process) appends one line to `<project>/.vibe-teamlead/usage.jsonl`
 * when it ends. Appending small lines is safe from several worker threads at
 * once, and the file survives restarts. No Electron imports: the worker uses it.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GatewayModelUsage, ModelPrice, ProjectUsageSummary, UsageBilling } from '../../../shared/types/usage';

export const USAGE_FILE = 'usage.jsonl';
const APP_DIR = '.vibe-teamlead';

export interface UsageEntry {
  /** ISO time the session ended */
  at: string;
  agentType: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cost Claude Code reported for the session (USD) */
  costUsd: number;
  /** How the tokens are paid for: only 'api' sessions are priced by Claude Code correctly */
  billing: UsageBilling;
  /** Host of the gateway, for billing 'gateway' */
  gateway?: string;
  /** The task, when the session belongs to one */
  specId?: string;
  outcome?: string;
  turns?: number;
  toolCalls?: number;
  durationMs?: number;
}

/**
 * The project a session's folder belongs to: the folder that holds a task
 * worktree (`<project>/.vibe-teamlead/worktrees/...`), or the folder itself
 * when it has the app's folder. Scratch folders (titles, commit messages run
 * without a project folder) belong to none.
 */
export function projectRootFor(dir: string | undefined): string | null {
  if (!dir) return null;
  const normalized = path.resolve(dir);
  const marker = `${path.sep}${APP_DIR}${path.sep}`;
  const at = normalized.indexOf(marker);
  if (at > 0) return normalized.slice(0, at);
  return existsSync(path.join(normalized, APP_DIR)) ? normalized : null;
}

/** How a session is billed, from its credentials. Pure. */
export function billingOf(auth: { baseURL?: string; oauthToken?: string }): { billing: UsageBilling; gateway?: string } {
  if (auth.oauthToken) return { billing: 'subscription' };
  if (auth.baseURL) {
    try {
      const host = new URL(auth.baseURL).host;
      if (host !== 'api.anthropic.com') return { billing: 'gateway', gateway: host };
    } catch {
      return { billing: 'gateway', gateway: auth.baseURL };
    }
  }
  return { billing: 'api' };
}

/** Append one session's usage to its project's ledger. Best effort: never throws. */
export async function recordUsage(dir: string | undefined, entry: UsageEntry): Promise<void> {
  const root = projectRootFor(dir);
  if (!root) return;
  if (entry.input + entry.output + entry.cacheRead + entry.cacheWrite === 0) return;
  try {
    const folder = path.join(root, APP_DIR);
    await mkdir(folder, { recursive: true });
    await appendFile(path.join(folder, USAGE_FILE), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Usage is informational; a read-only project must not fail the session
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

const MILLION = 1_000_000;

/** The prices of a model, if the user entered them. Own keys only: the name comes from the ledger, a file agents can reach. */
function priceOf(prices: Record<string, ModelPrice>, model: string): ModelPrice | undefined {
  return Object.hasOwn(prices, model) ? prices[model] : undefined;
}

/**
 * Totals of a ledger's lines (malformed lines are skipped). Pure.
 * Through a gateway, the figure Claude Code reports is its own guess for a model
 * it doesn't know, so dollars there come only from the prices the user entered.
 */
export function summarizeUsage(text: string, prices: Record<string, ModelPrice> = {}): ProjectUsageSummary {
  const models = new Map<string, GatewayModelUsage>();
  const tasks = new Map<string, number>();
  const summary: ProjectUsageSummary = {
    sessions: 0,
    totalTokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    pricedTokens: 0,
    subscriptionTokens: 0,
    gatewayTokens: 0,
    gateways: [],
    gatewayCostUsd: 0,
    gatewayCostKinds: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    gatewayModels: [],
    gatewayModelsUnpriced: [],
    gatewayTasks: [],
    byAgent: {},
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Partial<UsageEntry>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const input = num(e.input);
    const output = num(e.output);
    const cacheRead = num(e.cacheRead);
    const cacheWrite = num(e.cacheWrite);
    const tokens = input + output + cacheRead + cacheWrite;
    if (tokens === 0) continue;
    summary.sessions++;
    summary.totalTokens += tokens;
    summary.input += input;
    summary.output += output;
    summary.cacheRead += cacheRead;
    summary.cacheWrite += cacheWrite;
    if (e.billing === 'subscription') summary.subscriptionTokens += tokens;
    else if (e.billing === 'gateway') {
      summary.gatewayTokens += tokens;
      if (e.gateway && !summary.gateways.includes(e.gateway)) summary.gateways.push(e.gateway);
      const model = typeof e.model === 'string' && e.model ? e.model : 'unknown';
      const row = models.get(model) ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      models.set(model, row);
      row.input += input;
      row.output += output;
      row.cacheRead += cacheRead;
      row.cacheWrite += cacheWrite;
      const price = priceOf(prices, model);
      if (price) {
        const kinds = {
          input: (input * num(price.input)) / MILLION,
          output: (output * num(price.output)) / MILLION,
          cacheRead: (cacheRead * num(price.cacheRead)) / MILLION,
          cacheWrite: (cacheWrite * (price.cacheWrite === undefined ? num(price.input) : num(price.cacheWrite))) / MILLION,
        };
        const cost = kinds.input + kinds.output + kinds.cacheRead + kinds.cacheWrite;
        row.costUsd = (row.costUsd ?? 0) + cost;
        summary.gatewayCostUsd += cost;
        summary.gatewayCostKinds.input += kinds.input;
        summary.gatewayCostKinds.output += kinds.output;
        summary.gatewayCostKinds.cacheRead += kinds.cacheRead;
        summary.gatewayCostKinds.cacheWrite += kinds.cacheWrite;
        if (typeof e.specId === 'string' && e.specId) tasks.set(e.specId, (tasks.get(e.specId) ?? 0) + cost);
      }
    } else {
      summary.pricedTokens += tokens;
      summary.costUsd += num(e.costUsd);
    }
    const agent = typeof e.agentType === 'string' && e.agentType ? e.agentType : 'other';
    summary.byAgent[agent] = (summary.byAgent[agent] ?? 0) + tokens;
    if (typeof e.at === 'string' && (!summary.since || e.at < summary.since)) summary.since = e.at;
  }
  summary.gatewayModels = [...models.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));
  summary.gatewayModelsUnpriced = summary.gatewayModels.filter((row) => row.costUsd === undefined).map((row) => row.model);
  summary.gatewayTasks = [...tasks].map(([specId, costUsd]) => ({ specId, costUsd })).sort((a, b) => b.costUsd - a.costUsd);
  return summary;
}

/** The project's usage so far. */
export async function readProjectUsage(projectPath: string, prices: Record<string, ModelPrice> = {}): Promise<ProjectUsageSummary> {
  try {
    return summarizeUsage(await readFile(path.join(projectPath, APP_DIR, USAGE_FILE), 'utf-8'), prices);
  } catch {
    return summarizeUsage('', prices);
  }
}
