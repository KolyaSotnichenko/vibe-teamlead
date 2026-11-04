/** How a session's tokens are paid for */
export type UsageBilling = 'api' | 'subscription' | 'gateway';

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
  /** Tokens per agent type (spec_writer, planner, coder, qa_reviewer, ...) */
  byAgent: Record<string, number>;
  /** Earliest session recorded (ISO) */
  since?: string;
}
