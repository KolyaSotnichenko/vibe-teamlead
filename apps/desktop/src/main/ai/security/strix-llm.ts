/**
 * Which model Security QA (Strix) runs on, and with what credentials.
 *
 * "Same as agents" (the default) is the app's Claude key and base URL with the
 * task's QA model; a Claude subscription token cannot drive Strix, so then the
 * scan is skipped. Every other provider gets only its own variables, exactly as
 * Strix's docs name them (docs.strix.ai/llm-providers) — never the Claude key.
 * Pure: tested directly.
 */

import {
  STRIX_PROVIDERS,
  type StrixProviderFields,
  type StrixProviderId,
  type StrixSecretName,
} from '../../../shared/constants/strix-providers';
import { isSubscriptionToken } from '../claude-code/auth';

export interface StrixLlmChoice {
  provider: StrixProviderId;
  /** LiteLLM model id, `provider/model` (ignored for "Same as agents") */
  model: string;
  fields: StrixProviderFields;
  secrets: Partial<Record<StrixSecretName, string>>;
}

/** The app's Claude credential and the task's QA model, for "Same as agents". */
export interface StrixAgentsCredential {
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export type ResolvedStrixLlm =
  | { ok: true; provider: StrixProviderId; model: string; env: Record<string, string>; secrets: string[] }
  | { ok: false; reason: string };

const LABELS: Record<StrixProviderId, string> = {
  agents: 'Same as agents',
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  local: 'Local / OpenAI-compatible',
  chatgpt: 'ChatGPT subscription',
};

const WHERE = 'Settings → Agent Settings → Security QA';

/** LiteLLM model id for an Anthropic model. */
export function strixModel(model: string): string {
  return model.includes('/') ? model : `anthropic/${model}`;
}

function withPrefix(provider: StrixProviderId, model: string): string {
  if (provider === 'local') return model.includes('/') ? model : `openai/${model}`;
  const prefix = STRIX_PROVIDERS[provider].prefix;
  if (!prefix || model.startsWith(`${prefix}/`)) return model;
  return `${prefix}/${model}`;
}

export function resolveStrixLlm(choice: StrixLlmChoice | undefined, agents: StrixAgentsCredential): ResolvedStrixLlm {
  const provider = choice?.provider ?? 'agents';
  if (!choice || provider === 'agents') {
    if (!agents.apiKey || isSubscriptionToken(agents.apiKey)) {
      return {
        ok: false,
        reason: `Strix needs an Anthropic API key (a Claude subscription cannot be used for it); choose another model for Strix in ${WHERE}`,
      };
    }
    return {
      ok: true,
      provider: 'agents',
      model: strixModel(agents.model),
      env: { LLM_API_KEY: agents.apiKey, ...(agents.baseURL ? { LLM_API_BASE: agents.baseURL } : {}) },
      secrets: [agents.apiKey],
    };
  }

  const f = (name: keyof StrixProviderFields) => String(choice.fields[name] ?? '').trim();
  const s = (name: StrixSecretName) => String(choice.secrets[name] ?? '').trim();
  const env: Record<string, string> = {};
  const missing: string[] = [];
  const need = (variable: string, value: string, label: string) => {
    if (value) env[variable] = value;
    else missing.push(label);
  };
  const optional = (variable: string, value: string) => {
    if (value) env[variable] = value;
  };

  const model = choice.model.trim();
  if (!model) missing.push('model');

  switch (provider) {
    case 'openrouter':
    case 'vercel':
    case 'anthropic':
    case 'deepseek':
    case 'moonshot':
      need('LLM_API_KEY', s('apiKey'), 'API key');
      break;
    case 'openai':
      need('LLM_API_KEY', s('apiKey'), 'API key');
      optional('LLM_API_BASE', f('apiBase'));
      break;
    case 'azure':
      need('AZURE_API_KEY', s('azureApiKey'), 'API key');
      need('AZURE_API_BASE', f('azureApiBase'), 'endpoint');
      need('AZURE_API_VERSION', f('azureApiVersion'), 'API version');
      break;
    case 'bedrock':
      if ((choice.fields.awsAuth ?? 'keys') === 'profile') {
        need('AWS_PROFILE', f('awsProfile'), 'AWS profile');
      } else {
        need('AWS_ACCESS_KEY_ID', f('awsAccessKeyId'), 'access key ID');
        need('AWS_SECRET_ACCESS_KEY', s('awsSecretAccessKey'), 'secret access key');
      }
      need('AWS_REGION', f('awsRegion'), 'region');
      break;
    case 'vertex':
      need('VERTEXAI_PROJECT', f('vertexProject'), 'project');
      need('VERTEXAI_LOCATION', f('vertexLocation'), 'location');
      optional('GOOGLE_APPLICATION_CREDENTIALS', f('vertexCredentialsFile'));
      break;
    case 'local':
      need('LLM_API_BASE', f('apiBase'), 'base URL');
      optional('LLM_API_KEY', s('apiKey'));
      break;
    case 'chatgpt':
      // Strix's own login (`strix auth login chatgpt`), nothing to pass
      break;
  }

  if (missing.length) {
    return { ok: false, reason: `Strix on ${LABELS[provider]} is missing: ${missing.join(', ')} (${WHERE})` };
  }
  const secretVars = ['LLM_API_KEY', 'AZURE_API_KEY', 'AWS_SECRET_ACCESS_KEY'];
  return {
    ok: true,
    provider,
    model: withPrefix(provider, model),
    env,
    secrets: secretVars.map((name) => env[name]).filter((value): value is string => !!value),
  };
}

/** Masks the secrets in a line of Strix output (the same masking as the app's own checks). */
export function redactStrixSecrets(line: string, secrets: readonly string[]): string {
  return secrets.reduce((text, value) => (value.length >= 4 ? text.split(value).join('***') : text), line);
}
