/** How a session's tokens are paid for */
export type UsageBilling = 'api' | 'subscription' | 'gateway';

/** What the user pays their gateway for a model, in USD per million tokens */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** When unset, cache writes cost the input price */
  cacheWrite?: number;
}

/** A price and the time it counts from; '' for the first, which also covers the history before it */
export interface DatedModelPrice extends ModelPrice {
  from: string;
  /** When it was entered: the first price's `from` is '', and a correction that day must still replace it */
  enteredAt?: string;
}

/** Per model; a single price is what was saved before dates existed */
export type GatewayPrices = Record<string, ModelPrice | DatedModelPrice[]>;

/** A model's tokens through a gateway. costUsd is unset until the user enters its price. */
export interface GatewayModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

/** Token usage of a project, summed over all its Claude Code sessions */
export interface ProjectUsageSummary {
  sessions: number;
  /** input + output + cache read + cache write */
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cost of the Anthropic API sessions, as Claude Code reported it (USD) */
  costUsd: number;
  /** Tokens of Anthropic API sessions (the ones costUsd covers) */
  pricedTokens: number;
  /** Tokens under a Claude subscription (no per-token price) */
  subscriptionTokens: number;
  /** Tokens through a gateway (priced by the gateway, not here) */
  gatewayTokens: number;
  gateways: string[];
  /** What the gateway tokens cost at the user's prices: only the models that have one */
  gatewayCostUsd: number;
  /** That cost by kind of token: which kind the bill really goes to */
  gatewayCostKinds: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Most expensive first; models without a price last */
  gatewayModels: GatewayModelUsage[];
  /** Models still without a price, so gatewayCostUsd leaves them out */
  gatewayModelsUnpriced: string[];
  /** Cost per task at the user's prices, most expensive first */
  gatewayTasks: { specId: string; costUsd: number }[];
  /** Tokens per agent type (spec_writer, planner, coder, qa_reviewer, ...) */
  byAgent: Record<string, number>;
  /** Earliest session recorded (ISO) */
  since?: string;
}
