import { describe, expect, it } from 'vitest';

import { pickClaudeCredential } from '../credential';
import { pickLegacyClaudeCredential, stripLegacySettings } from '../credential-migration';

describe('pickClaudeCredential', () => {
  it('prefers the key stored in the app over the environment', () => {
    expect(
      pickClaudeCredential({
        storedKey: 'sk-ant-api03-stored',
        env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' },
        subscriptionMode: false,
      }),
    ).toEqual({ key: 'sk-ant-api03-stored', baseURL: undefined, source: 'stored' });
  });

  it('falls back to ANTHROPIC_API_KEY', () => {
    expect(pickClaudeCredential({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-env' }, subscriptionMode: false })).toEqual({
      key: 'sk-ant-api03-env',
      baseURL: undefined,
      source: 'environment',
    });
  });

  it('uses CLAUDE_CODE_OAUTH_TOKEN only in personal mode', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env' };
    expect(pickClaudeCredential({ env, subscriptionMode: false })).toEqual({ baseURL: undefined, source: 'none' });
    expect(pickClaudeCredential({ env, subscriptionMode: true })).toEqual({
      key: 'sk-ant-oat01-env',
      baseURL: undefined,
      source: 'environment',
    });
  });

  it('takes the base URL from settings, then ANTHROPIC_BASE_URL', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://env.example' };
    expect(
      pickClaudeCredential({ storedKey: 'k', baseUrlSetting: ' https://gw.example ', env, subscriptionMode: false }).baseURL,
    ).toBe('https://gw.example');
    expect(pickClaudeCredential({ storedKey: 'k', baseUrlSetting: '', env, subscriptionMode: false }).baseURL).toBe(
      'https://env.example',
    );
  });
});

describe('pickLegacyClaudeCredential', () => {
  it('takes the active Anthropic API-key account first, with its base URL', () => {
    const settings = {
      providerAccounts: [
        { provider: 'openai', authType: 'api-key', apiKey: 'sk-openai' },
        { provider: 'anthropic', authType: 'api-key', apiKey: 'sk-ant-old' },
        { provider: 'anthropic', authType: 'api-key', apiKey: 'sk-ant-active', baseUrl: 'https://gw', isActive: true },
      ],
      globalAnthropicApiKey: 'sk-ant-global',
    };
    expect(pickLegacyClaudeCredential({ settings })).toEqual({ apiKey: 'sk-ant-active', baseUrl: 'https://gw' });
  });

  it('ignores accounts of other providers and OAuth accounts', () => {
    const settings = {
      providerAccounts: [
        { provider: 'openai', authType: 'api-key', apiKey: 'sk-openai' },
        { provider: 'anthropic', authType: 'oauth', apiKey: 'sk-ant-oat01-x' },
      ],
      globalAnthropicApiKey: 'sk-ant-global',
    };
    expect(pickLegacyClaudeCredential({ settings })).toEqual({ apiKey: 'sk-ant-global' });
  });

  it('falls back to the active API profile, then to a Claude profile token', () => {
    expect(
      pickLegacyClaudeCredential({
        settings: {},
        apiProfiles: {
          profiles: [
            { id: 'a', apiKey: 'sk-a', baseUrl: 'https://a' },
            { id: 'b', apiKey: 'sk-b', baseUrl: 'https://b' },
          ],
          activeProfileId: 'b',
        },
      }),
    ).toEqual({ apiKey: 'sk-b', baseUrl: 'https://b' });

    expect(
      pickLegacyClaudeCredential({
        settings: {},
        claudeProfiles: { profiles: [{ id: 'p', oauthToken: 'enc:token' }] },
        decrypt: (value) => value.replace('enc:', 'sk-ant-oat01-'),
      }),
    ).toEqual({ apiKey: 'sk-ant-oat01-token' });
  });

  it('returns nothing when no Claude key exists', () => {
    expect(pickLegacyClaudeCredential({ settings: { globalOpenAIApiKey: 'sk-openai' } })).toBeUndefined();
  });
});

describe('stripLegacySettings', () => {
  it('drops the removed fields and keeps memory keys', () => {
    const { settings, changed } = stripLegacySettings({
      providerAccounts: [],
      globalPriorityOrder: [],
      globalAnthropicApiKey: 'sk-ant',
      providerAgentConfig: {},
      globalOpenAIApiKey: 'sk-openai',
      globalGoogleApiKey: 'g',
      theme: 'dark',
    });
    expect(changed).toBe(true);
    expect(settings).toEqual({ globalOpenAIApiKey: 'sk-openai', globalGoogleApiKey: 'g', theme: 'dark' });
  });

  it('reports no change for clean settings', () => {
    expect(stripLegacySettings({ theme: 'dark' }).changed).toBe(false);
  });
});
