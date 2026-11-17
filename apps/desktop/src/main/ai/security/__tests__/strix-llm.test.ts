import { describe, expect, it } from 'vitest';

import { redactStrixSecrets, resolveStrixLlm, type StrixAgentsCredential, type StrixLlmChoice } from '../strix-llm';

const agents: StrixAgentsCredential = { model: 'claude-sonnet-4-6', apiKey: 'sk-ant-api-CLAUDE', baseURL: 'https://gw.example' };

const choice = (over: Partial<StrixLlmChoice>): StrixLlmChoice => ({ provider: 'agents', model: '', fields: {}, secrets: {}, ...over });

/** The resolved environment, or the test fails with the reason */
function envOf(c: StrixLlmChoice, a = agents) {
  const r = resolveStrixLlm(c, a);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe('resolveStrixLlm', () => {
  it('same as agents: the Claude key, base URL and the agents model (today\'s behaviour)', () => {
    const r = envOf(choice({}));
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
    expect(r.env).toEqual({ LLM_API_KEY: 'sk-ant-api-CLAUDE', LLM_API_BASE: 'https://gw.example' });
    expect(r.secrets).toEqual(['sk-ant-api-CLAUDE']);
    expect(envOf(choice({}), { model: 'm' , apiKey: 'k-1234' }).env).toEqual({ LLM_API_KEY: 'k-1234' });
    // No choice at all is the same
    expect(resolveStrixLlm(undefined, agents)).toEqual(r);
  });

  it('same as agents: skipped without a key or with a subscription token, pointing to another provider', () => {
    for (const apiKey of [undefined, 'sk-ant-oat01-x']) {
      const r = resolveStrixLlm(choice({}), { model: 'm', apiKey });
      expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Anthropic API key.*Settings → Agent Settings → Security QA/) });
    }
  });

  it('a subscription token is no obstacle for another provider', () => {
    const r = envOf(choice({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', secrets: { apiKey: 'sk-or-1' } }), { model: 'm', apiKey: 'sk-ant-oat01-x' });
    expect(r.env).toEqual({ LLM_API_KEY: 'sk-or-1' });
  });

  it.each([
    ['openrouter', 'openrouter/z-ai/glm-5.3'],
    ['vercel', 'vercel_ai_gateway/zai/glm-5.3'],
    ['anthropic', 'anthropic/claude-sonnet-5-5'],
    ['deepseek', 'deepseek/deepseek-v4-pro'],
    ['moonshot', 'moonshot/kimi-k3.1-pro'],
  ] as const)('%s: LLM_API_KEY only, never the Claude key', (provider, model) => {
    const r = envOf(choice({ provider, model, secrets: { apiKey: ' key-1 ' }, fields: { apiBase: 'http://ignored' } }));
    expect(r.model).toBe(model);
    expect(r.env).toEqual({ LLM_API_KEY: 'key-1' });
    expect(JSON.stringify(r.env)).not.toContain('CLAUDE');
    expect(r.secrets).toEqual(['key-1']);
  });

  it('adds the provider prefix to a model typed without it (gateways keep their own namespace)', () => {
    expect(envOf(choice({ provider: 'openrouter', model: 'z-ai/glm-5.3', secrets: { apiKey: 'k' } })).model).toBe('openrouter/z-ai/glm-5.3');
    expect(envOf(choice({ provider: 'deepseek', model: 'deepseek-v4-pro', secrets: { apiKey: 'k' } })).model).toBe('deepseek/deepseek-v4-pro');
    expect(envOf(choice({ provider: 'local', model: 'local-model', fields: { apiBase: 'http://localhost:1234/v1' } })).model).toBe('openai/local-model');
    expect(envOf(choice({ provider: 'local', model: 'ollama/qwen3-vl', fields: { apiBase: 'http://localhost:11434' } })).model).toBe('ollama/qwen3-vl');
  });

  it('openai: key, and the base URL only when given', () => {
    expect(envOf(choice({ provider: 'openai', model: 'openai/gpt-6.1-sol', secrets: { apiKey: 'sk-o' } })).env).toEqual({ LLM_API_KEY: 'sk-o' });
    expect(envOf(choice({ provider: 'openai', model: 'openai/x', secrets: { apiKey: 'sk-o' }, fields: { apiBase: 'https://compat.example/v1' } })).env).toEqual({
      LLM_API_KEY: 'sk-o',
      LLM_API_BASE: 'https://compat.example/v1',
    });
  });

  it('azure: key, endpoint and version', () => {
    const r = envOf(
      choice({ provider: 'azure', model: 'azure/my-gpt', secrets: { azureApiKey: 'az-1' }, fields: { azureApiBase: 'https://x.openai.azure.com', azureApiVersion: '2025-11-01-preview' } }),
    );
    expect(r.env).toEqual({ AZURE_API_KEY: 'az-1', AZURE_API_BASE: 'https://x.openai.azure.com', AZURE_API_VERSION: '2025-11-01-preview' });
    expect(r.secrets).toEqual(['az-1']);
  });

  it('bedrock: access keys + region, or a profile + region', () => {
    const keys = envOf(
      choice({ provider: 'bedrock', model: 'bedrock/us.anthropic.claude-sonnet-5-5', secrets: { awsSecretAccessKey: 'SECRET' }, fields: { awsAccessKeyId: 'AKIA1', awsRegion: 'us-east-1' } }),
    );
    expect(keys.env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: 'SECRET', AWS_REGION: 'us-east-1' });
    expect(keys.secrets).toEqual(['SECRET']);
    const profile = envOf(
      choice({ provider: 'bedrock', model: 'bedrock/x', secrets: { awsSecretAccessKey: 'SECRET' }, fields: { awsAuth: 'profile', awsProfile: 'dev', awsRegion: 'eu-west-1', awsAccessKeyId: 'AKIA1' } }),
    );
    expect(profile.env).toEqual({ AWS_PROFILE: 'dev', AWS_REGION: 'eu-west-1' });
  });

  it('vertex: project and location, credentials file only when given', () => {
    expect(envOf(choice({ provider: 'vertex', model: 'vertex_ai/gemini-4-argon', fields: { vertexProject: 'p', vertexLocation: 'global' } })).env).toEqual({
      VERTEXAI_PROJECT: 'p',
      VERTEXAI_LOCATION: 'global',
    });
    expect(
      envOf(choice({ provider: 'vertex', model: 'vertex_ai/g', fields: { vertexProject: 'p', vertexLocation: 'global', vertexCredentialsFile: '/k/sa.json' } })).env,
    ).toEqual({ VERTEXAI_PROJECT: 'p', VERTEXAI_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: '/k/sa.json' });
  });

  it('local: base URL, key only when given', () => {
    expect(envOf(choice({ provider: 'local', model: 'ollama/qwen3-vl', fields: { apiBase: 'http://localhost:11434' } })).env).toEqual({ LLM_API_BASE: 'http://localhost:11434' });
    expect(envOf(choice({ provider: 'local', model: 'ollama/q', fields: { apiBase: 'http://h' }, secrets: { apiKey: 'lk' } })).env).toEqual({
      LLM_API_BASE: 'http://h',
      LLM_API_KEY: 'lk',
    });
  });

  it('chatgpt: no variables (Strix uses its own login)', () => {
    const r = envOf(choice({ provider: 'chatgpt', model: 'chatgpt/gpt-5.4', secrets: { apiKey: 'stale' } }));
    expect(r.env).toEqual({});
    expect(r.model).toBe('chatgpt/gpt-5.4');
  });

  it.each([
    [choice({ provider: 'openrouter', model: 'openrouter/x' }), /OpenRouter.*API key/],
    [choice({ provider: 'openrouter', model: ' ', secrets: { apiKey: 'k' } }), /model/],
    [choice({ provider: 'azure', model: 'azure/d', secrets: { azureApiKey: 'k' } }), /endpoint.*API version/],
    [choice({ provider: 'bedrock', model: 'bedrock/x', fields: { awsRegion: 'r' } }), /access key ID.*secret access key/],
    [choice({ provider: 'bedrock', model: 'bedrock/x', fields: { awsAuth: 'profile', awsProfile: 'p' } }), /region/],
    [choice({ provider: 'vertex', model: 'vertex_ai/x', fields: { vertexProject: 'p' } }), /location/],
    [choice({ provider: 'local', model: 'ollama/x' }), /base URL/],
  ])('missing required fields: skipped, naming what is missing', (c, reason) => {
    const r = resolveStrixLlm(c, agents);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(reason);
      expect(r.reason).toMatch(/Settings → Agent Settings → Security QA/);
    }
  });
});

describe('redactStrixSecrets', () => {
  it('masks every secret in a line, ignoring very short values', () => {
    expect(redactStrixSecrets('auth failed for sk-or-123456 and AKIA/SECRETXYZ', ['sk-or-123456', 'SECRETXYZ', 'ab'])).toBe('auth failed for *** and AKIA/***');
    expect(redactStrixSecrets('nothing', [])).toBe('nothing');
  });
});
