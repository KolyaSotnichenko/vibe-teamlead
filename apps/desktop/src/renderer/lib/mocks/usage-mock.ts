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
      gatewayCostUsd: 8.2,
      gatewayCostKinds: { input: 1.9, output: 2.6, cacheRead: 3.7, cacheWrite: 0 },
      gatewayModels: [
        { model: 'glm-5.3', input: 400_000, output: 200_000, cacheRead: 5_400_000, cacheWrite: 0, costUsd: 8.2 },
        { model: 'kimi-k2.7-code', input: 100_000, output: 30_000, cacheRead: 200_000, cacheWrite: 0 },
      ],
      gatewayModelsUnpriced: ['kimi-k2.7-code'],
      gatewayTasks: [{ specId: '008-idea-submission', costUsd: 8.2 }],
      byAgent: { coder: 10_200_000, qa_reviewer: 3_900_000, planner: 2_100_000, spec_writer: 1_600_000, qa_fixer: 630_000 },
      since: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    },
  }),
};
