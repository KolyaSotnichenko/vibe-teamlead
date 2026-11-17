import { describe, expect, it, vi } from 'vitest';

import { strixLlmChoiceFrom } from '../strix-setting';

const store = (secrets: Record<string, Record<string, string>>) => ({ load: vi.fn((p: string) => ({ ...(secrets[p] ?? {}) })) });

describe('strixLlmChoiceFrom', () => {
  it('defaults to the agents, with no secrets read', () => {
    const s = store({ openrouter: { apiKey: 'k' } });
    expect(strixLlmChoiceFrom({}, s)).toEqual({ provider: 'agents', model: '', fields: {}, secrets: {} });
    expect(strixLlmChoiceFrom({ securityQaProvider: 'nonsense' }, s).provider).toBe('agents');
    expect(s.load).not.toHaveBeenCalled();
  });

  it("reads the chosen provider's model, fields and only its secrets", () => {
    const s = store({ bedrock: { awsSecretAccessKey: 'S' }, openrouter: { apiKey: 'other' } });
    const choice = strixLlmChoiceFrom(
      {
        securityQaProvider: 'bedrock',
        securityQaModel: 'bedrock/x',
        securityQaProviderFields: { awsAuth: 'keys', awsAccessKeyId: 'AKIA', awsRegion: 7, bogus: 'x', awsProfile: '' },
      },
      s,
    );
    expect(choice).toEqual({ provider: 'bedrock', model: 'bedrock/x', fields: { awsAuth: 'keys', awsAccessKeyId: 'AKIA' }, secrets: { awsSecretAccessKey: 'S' } });
    expect(s.load).toHaveBeenCalledWith('bedrock');
  });

  it('a secret store that fails gives no secrets, not another credential', () => {
    const failing = { load: () => { throw new Error('keychain refused'); } };
    expect(strixLlmChoiceFrom({ securityQaProvider: 'openai', securityQaModel: 'openai/x' }, failing)).toMatchObject({ provider: 'openai', secrets: {} });
  });

  it('drops an unknown AWS auth mode', () => {
    expect(strixLlmChoiceFrom({ securityQaProvider: 'bedrock', securityQaProviderFields: { awsAuth: 'sso' } }, store({})).fields).toEqual({});
  });
});
