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
  /** Before the app quits: run the handler (the Settings dialog's save), then let main go on. Returns the unsubscribe. */
  onFlushBeforeQuit: (handler: () => Promise<unknown>) => () => void;

  // CLI Tools Detection
  getCliToolsInfo: () => Promise<IPCResult<{
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    claude: ToolDetectionResult;
  }>>;

  // App Info
  getAppVersion: () => Promise<string>;

  // Sentry error reporting
  notifySentryStateChanged: (enabled: boolean) => void;
  getSentryConfig: () => Promise<{ dsn: string; tracesSampleRate: number; profilesSampleRate: number }>;

  // Spell check
  setSpellCheckLanguages: (language: string) => Promise<IPCResult<{ success: boolean }>>;

  // Claude credential (the key is write-only from the renderer)
  getClaudeCredentialStatus: () => Promise<IPCResult<ClaudeCredentialStatus>>;
  saveClaudeApiKey: (apiKey: string) => Promise<IPCResult<ClaudeCredentialStatus>>;
  clearClaudeApiKey: (slot?: 'api' | 'subscription') => Promise<IPCResult<ClaudeCredentialStatus>>;
  testClaudeConnection: (input?: ClaudeConnectionTestInput) => Promise<IPCResult<ClaudeConnectionTestResult>>;
  /** Models offered by the configured endpoint (Anthropic API or the base URL) */
  listClaudeModels: (options?: { refresh?: boolean }) => Promise<IPCResult<ClaudeModelList>>;
}

// Every open handler runs before main is told it may quit; with none, main is told at once
const flushHandlers = new Set<() => Promise<unknown>>();
ipcRenderer.on(IPC_CHANNELS.SETTINGS_FLUSH_BEFORE_QUIT, (_event, id: string) => {
  void Promise.allSettled([...flushHandlers].map((handler) => handler())).then(() =>
    ipcRenderer.send(IPC_CHANNELS.SETTINGS_FLUSHED_BEFORE_QUIT, id)
  );
});

export const createSettingsAPI = (): SettingsAPI => ({
  // App Settings
  getSettings: (): Promise<IPCResult<AppSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

  saveSettings: (settings: Partial<AppSettings>): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

  onFlushBeforeQuit: (handler: () => Promise<unknown>): (() => void) => {
    flushHandlers.add(handler);
    return () => flushHandlers.delete(handler);
  },

  // CLI Tools Detection
  getCliToolsInfo: (): Promise<IPCResult<{
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    claude: ToolDetectionResult;
  }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO),

  // App Info
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

  // Sentry error reporting - notify main process when setting changes
  notifySentryStateChanged: (enabled: boolean): void =>
    ipcRenderer.send(IPC_CHANNELS.SENTRY_STATE_CHANGED, enabled),

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
  clearClaudeApiKey: (slot?: 'api' | 'subscription'): Promise<IPCResult<ClaudeCredentialStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CREDENTIAL_CLEAR, slot),
  testClaudeConnection: (input?: ClaudeConnectionTestInput): Promise<IPCResult<ClaudeConnectionTestResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CREDENTIAL_TEST, input),
  listClaudeModels: (options?: { refresh?: boolean }): Promise<IPCResult<ClaudeModelList>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_MODELS_LIST, options),
});
