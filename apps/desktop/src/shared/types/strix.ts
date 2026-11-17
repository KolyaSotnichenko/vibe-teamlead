import type { StrixProviderId, StrixSecretName, StrixSecretStatus } from '../constants/strix-providers';

export type StrixSecretResult = { success: true; data: StrixSecretStatus } | { success: false; error: string };

/** window.electronAPI.strix — Security QA's own secrets go in, never out (only which are saved) */
export interface StrixAPI {
  getSecretsStatus: () => Promise<StrixSecretStatus>;
  saveSecret: (provider: StrixProviderId, name: StrixSecretName, value: string) => Promise<StrixSecretResult>;
  clearSecret: (provider: StrixProviderId, name: StrixSecretName) => Promise<StrixSecretResult>;
  /** A Vertex AI service-account JSON file; null when cancelled */
  pickCredentialsFile: () => Promise<string | null>;
}
