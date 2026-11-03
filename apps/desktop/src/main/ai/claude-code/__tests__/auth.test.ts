import { describe, expect, it } from 'vitest';

import { toClaudeAuth } from '../auth';
import { buildEnv, runAgentSession } from '../runner';
import type { SessionConfig } from '../../session/types';

const base: SessionConfig = {
  agentType: 'coder',
  model: 'claude-sonnet-4-6',
  auth: {},
  systemPrompt: 's',
  initialMessages: [{ role: 'user', content: 'go' }],
  toolContext: { cwd: '/w', projectDir: '/w', specDir: '/w/s', securityProfile: undefined as never },
  maxSteps: 5,
  specDir: '/w/s',
  projectDir: '/w',
};

describe('subscription (personal) mode', () => {
  it('keeps API keys as API keys', () => {
    expect(toClaudeAuth('sk-ant-api03-x', 'https://gw', false)).toEqual({ apiKey: 'sk-ant-api03-x', baseURL: 'https://gw' });
  });

  it('accepts a subscription token only when the switch is on', () => {
    expect(toClaudeAuth('sk-ant-oat01-x', undefined, true)).toEqual({ oauthToken: 'sk-ant-oat01-x' });
    expect(toClaudeAuth('sk-ant-oat01-x', undefined, false)).toEqual({ rejectedSubscriptionToken: true });
  });

  it('passes the subscription token as CLAUDE_CODE_OAUTH_TOKEN and keeps claude.ai connectors out', () => {
    const env = buildEnv({ ...base, auth: { oauthToken: 'sk-ant-oat01-x' } });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-x');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it('explains how to enable it when a subscription token is rejected', async () => {
    const result = await runAgentSession({ ...base, auth: { rejectedSubscriptionToken: true } });
    expect(result.outcome).toBe('auth_failure');
    expect(result.error?.message).toMatch(/Use my Claude subscription/);
  });
});
