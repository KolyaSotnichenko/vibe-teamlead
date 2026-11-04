/** Browser mock: a project that has run a few tasks */
export const usageMock = {
  get: async () => ({
    success: true as const,
    data: {
      sessions: 42,
      totalTokens: 18_430_000,
      input: 1_210_000,
      output: 640_000,
      cacheRead: 15_900_000,
      cacheWrite: 680_000,
      costUsd: 23.47,
      pricedTokens: 12_100_000,
      subscriptionTokens: 0,
      gatewayTokens: 6_330_000,
      gateways: ['gw.example.com'],
      byAgent: { coder: 10_200_000, qa_reviewer: 3_900_000, planner: 2_100_000, spec_writer: 1_600_000, qa_fixer: 630_000 },
      since: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    },
  }),
};
