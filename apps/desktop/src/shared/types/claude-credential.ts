/**
 * The app's Claude credential, as the renderer sees it.
 * The key itself never leaves the main process.
 */

export interface ClaudeCredentialStatus {
  /** A key or token is available */
  configured: boolean;
  /** Where it comes from: saved in the app, the environment, or nowhere */
  source: 'stored' | 'environment' | 'none';
  /** An Anthropic API key, or a Claude subscription token (personal mode) */
  kind?: 'api-key' | 'subscription-token';
  /** Last four characters, to recognise the key */
  hint?: string;
}

/** Optional unsaved values to test instead of the stored ones */
export interface ClaudeConnectionTestInput {
  apiKey?: string;
  baseUrl?: string;
}

export interface ClaudeConnectionTestResult {
  ok: boolean;
  /** Short reason when the test fails */
  error?: string;
}
