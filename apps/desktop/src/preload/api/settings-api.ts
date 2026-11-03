import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AppSettings,
  IPCResult,
  ToolDetectionResult,
  ClaudeCredentialStatus,
  ClaudeConnectionTestInput,
  ClaudeConnectionTestResult,
  ClaudeModelList
} from '../../shared/types';

export interface SettingsAPI {
  // App Settings
  getSettings: () => Promise<IPCResult<AppSettings>>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<IPCResult>;

  // CLI Tools Detection
  getCliToolsInfo: () => Promise<IPCResult<{
    python: ToolDetectionResult;
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    claude: ToolDetectionResult;
  }>>;

  // Claude Code onboarding status
  getClaudeCodeOnboardingStatus: () => Promise<IPCResult<{ hasCompletedOnboarding: boolean }>>;

  // App Info
  getAppVersion: () => Promise<string>;

  // Sentry error reporting
  notifySentryStateChanged: (enabled: boolean) => void;
  getSentryDsn: () => Promise<string>;
  getSentryConfig: () => Promise<{ dsn: string; tracesSampleRate: number; profilesSampleRate: number }>;

  // Spell check
  setSpellCheckLanguages: (language: string) => Promise<IPCResult<{ success: boolean }>>;

  // Claude credential (the key is write-only from the renderer)
  getClaudeCredentialStatus: () => Promise<IPCResult<ClaudeCredentialStatus>>;
  saveClaudeApiKey: (apiKey: string) => Promise<IPCResult<ClaudeCredentialStatus>>;
  clearClaudeApiKey: () => Promise<IPCResult<ClaudeCredentialStatus>>;
  testClaudeConnection: (input?: ClaudeConnectionTestInput) => Promise<IPCResult<ClaudeConnectionTestResult>>;
  /** Models offered by the configured endpoint (Anthropic API or the base URL) */
  listClaudeModels: (options?: { refresh?: boolean }) => Promise<IPCResult<ClaudeModelList>>;
}

export const createSettingsAPI = (): SettingsAPI => ({
  // App Settings
  getSettings: (): Promise<IPCResult<AppSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

  saveSettings: (settings: Partial<AppSettings>): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

  // CLI Tools Detection
  getCliToolsInfo: (): Promise<IPCResult<{
    python: ToolDetectionResult;
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    claude: ToolDetectionResult;
  }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO),

  // Claude Code onboarding status
  getClaudeCodeOnboardingStatus: (): Promise<IPCResult<{ hasCompletedOnboarding: boolean }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS),

  // App Info
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

  // Sentry error reporting - notify main process when setting changes
  notifySentryStateChanged: (enabled: boolean): void =>
    ipcRenderer.send(IPC_CHANNELS.SENTRY_STATE_CHANGED, enabled),

  // Get Sentry DSN from main process (loaded from environment variable)
  getSentryDsn: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SENTRY_DSN),

  // Get full Sentry config from main process (DSN + sample rates)
  getSentryConfig: (): Promise<{ dsn: string; tracesSampleRate: number; profilesSampleRate: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SENTRY_CONFIG),

  // Spell check - sync spell checker language with app language
  setSpellCheckLanguages: (language: string): Promise<IPCResult<{ success: boolean }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPELLCHECK_SET_LANGUAGES, language),

  // Claude credential
  getClaudeCredentialStatus: (): Promise<IPCResult<ClaudeCredentialStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CREDENTIAL_GET_STATUS),
  saveClaudeApiKey: (apiKey: string): Promise<IPCResult<ClaudeCredentialStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CREDENTIAL_SAVE, apiKey),
  clearClaudeApiKey: (): Promise<IPCResult<ClaudeCredentialStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CREDENTIAL_CLEAR),
  testClaudeConnection: (input?: ClaudeConnectionTestInput): Promise<IPCResult<ClaudeConnectionTestResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CREDENTIAL_TEST, input),
  listClaudeModels: (options?: { refresh?: boolean }): Promise<IPCResult<ClaudeModelList>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_MODELS_LIST, options),
});
