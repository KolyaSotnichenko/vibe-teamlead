/**
 * The providers Security QA (Strix) can run on, from Strix's docs
 * (docs.strix.ai/llm-providers). Strix uses LiteLLM: the model is `provider/model`,
 * and each provider takes its own environment variables (see `security/strix-llm.ts`).
 * Shared by Settings → Security QA and the main process.
 */

export const STRIX_PROVIDER_IDS = [
  'agents',
  'openrouter',
  'vercel',
  'anthropic',
  'openai',
  'deepseek',
  'moonshot',
  'azure',
  'bedrock',
  'vertex',
  'local',
  'chatgpt',
] as const;

export type StrixProviderId = (typeof STRIX_PROVIDER_IDS)[number];

/** Secrets: kept encrypted in their own store, never in settings, never sent back to the renderer. */
export const STRIX_SECRET_NAMES = ['apiKey', 'azureApiKey', 'awsSecretAccessKey'] as const;
export type StrixSecretName = (typeof STRIX_SECRET_NAMES)[number];

/** Non-secret provider fields, kept in settings. */
export interface StrixProviderFields {
  /** LLM_API_BASE (OpenAI-compatible server, local server) */
  apiBase?: string;
  /** AZURE_API_BASE (endpoint URL) */
  azureApiBase?: string;
  /** AZURE_API_VERSION */
  azureApiVersion?: string;
  /** Bedrock: access keys or a named AWS profile */
  awsAuth?: 'keys' | 'profile';
  awsAccessKeyId?: string;
  awsProfile?: string;
  awsRegion?: string;
  vertexProject?: string;
  vertexLocation?: string;
  /** GOOGLE_APPLICATION_CREDENTIALS: a service-account JSON file; empty → gcloud ADC */
  vertexCredentialsFile?: string;
}

export type StrixFieldName = Exclude<keyof StrixProviderFields, 'awsAuth'>;

export type StrixProviderNote = 'accessProgram' | 'recommended' | 'smallLocalModels' | 'chatgptLogin' | 'agentsKey';

export interface StrixProviderInfo {
  id: StrixProviderId;
  /** LiteLLM prefix added to a model typed without it */
  prefix?: string;
  /** Prefilled into the model field when the provider is chosen */
  exampleModel: string;
  /** Shown when the model field is empty */
  modelPlaceholder: string;
  notes: StrixProviderNote[];
}

export const STRIX_PROVIDERS: Record<StrixProviderId, StrixProviderInfo> = {
  agents: { id: 'agents', exampleModel: '', modelPlaceholder: '', notes: ['agentsKey'] },
  openrouter: { id: 'openrouter', prefix: 'openrouter', exampleModel: 'openrouter/z-ai/glm-5.3', modelPlaceholder: 'openrouter/z-ai/glm-5.3', notes: ['recommended'] },
  vercel: {
    id: 'vercel',
    prefix: 'vercel_ai_gateway',
    exampleModel: 'vercel_ai_gateway/zai/glm-5.3',
    modelPlaceholder: 'vercel_ai_gateway/zai/glm-5.3',
    notes: ['recommended'],
  },
  anthropic: { id: 'anthropic', prefix: 'anthropic', exampleModel: 'anthropic/claude-sonnet-5-5', modelPlaceholder: 'anthropic/claude-sonnet-5-5', notes: ['accessProgram'] },
  openai: { id: 'openai', prefix: 'openai', exampleModel: 'openai/gpt-6.1-sol', modelPlaceholder: 'openai/gpt-6.1-sol', notes: ['accessProgram'] },
  deepseek: { id: 'deepseek', prefix: 'deepseek', exampleModel: 'deepseek/deepseek-v4-pro', modelPlaceholder: 'deepseek/deepseek-v4-pro', notes: [] },
  moonshot: { id: 'moonshot', prefix: 'moonshot', exampleModel: 'moonshot/kimi-k3.1-pro', modelPlaceholder: 'moonshot/kimi-k3.1-pro', notes: [] },
  azure: { id: 'azure', prefix: 'azure', exampleModel: '', modelPlaceholder: 'azure/<deployment-name>', notes: ['accessProgram'] },
  bedrock: {
    id: 'bedrock',
    prefix: 'bedrock',
    exampleModel: 'bedrock/us.anthropic.claude-sonnet-5-5',
    modelPlaceholder: 'bedrock/us.anthropic.claude-sonnet-5-5',
    notes: ['accessProgram'],
  },
  vertex: { id: 'vertex', prefix: 'vertex_ai', exampleModel: 'vertex_ai/gemini-4-argon', modelPlaceholder: 'vertex_ai/gemini-4-argon', notes: ['accessProgram'] },
  local: { id: 'local', exampleModel: 'ollama/qwen3-vl', modelPlaceholder: 'ollama/qwen3-vl', notes: ['smallLocalModels'] },
  chatgpt: { id: 'chatgpt', prefix: 'chatgpt', exampleModel: 'chatgpt/gpt-5.4', modelPlaceholder: 'chatgpt/gpt-5.4', notes: ['chatgptLogin', 'accessProgram'] },
};

/** The secrets a provider takes (required or optional), in the order the form shows them. */
export function strixProviderSecrets(provider: StrixProviderId, fields: StrixProviderFields = {}): StrixSecretName[] {
  switch (provider) {
    case 'openrouter':
    case 'vercel':
    case 'anthropic':
    case 'openai':
    case 'deepseek':
    case 'moonshot':
    case 'local':
      return ['apiKey'];
    case 'azure':
      return ['azureApiKey'];
    case 'bedrock':
      return (fields.awsAuth ?? 'keys') === 'keys' ? ['awsSecretAccessKey'] : [];
    default:
      return [];
  }
}

/** The non-secret fields a provider takes, in the order the form shows them. */
export function strixProviderFields(provider: StrixProviderId, fields: StrixProviderFields = {}): StrixFieldName[] {
  switch (provider) {
    case 'openai':
    case 'local':
      return ['apiBase'];
    case 'azure':
      return ['azureApiBase', 'azureApiVersion'];
    case 'bedrock':
      return (fields.awsAuth ?? 'keys') === 'keys' ? ['awsAccessKeyId', 'awsRegion'] : ['awsProfile', 'awsRegion'];
    case 'vertex':
      return ['vertexProject', 'vertexLocation', 'vertexCredentialsFile'];
    default:
      return [];
  }
}

/** Which secrets are saved, per provider: what the renderer is told instead of the secrets. */
export type StrixSecretStatus = Partial<Record<StrixProviderId, Partial<Record<StrixSecretName, boolean>>>>;

export function isStrixProviderId(value: unknown): value is StrixProviderId {
  return typeof value === 'string' && (STRIX_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isStrixSecretName(value: unknown): value is StrixSecretName {
  return typeof value === 'string' && (STRIX_SECRET_NAMES as readonly string[]).includes(value);
}
