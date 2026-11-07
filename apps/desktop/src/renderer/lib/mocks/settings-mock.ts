/**
 * Mock implementation for settings and app info operations
 */

import { DEFAULT_APP_SETTINGS } from '../../../shared/constants';
import type { ClaudeCredentialStatus } from '../../../shared/types';

// In-memory Claude credential so the settings UI can be tried in a browser
let mockCredential: ClaudeCredentialStatus = { configured: false, source: 'none' };

export const settingsMock = {
  // Settings
  getSettings: async () => ({
    success: true,
    data: DEFAULT_APP_SETTINGS
  }),

  saveSettings: async () => ({ success: true }),

  // Sentry error reporting
  notifySentryStateChanged: (_enabled: boolean) => {
    console.warn('[browser-mock] notifySentryStateChanged called');
  },
  getSentryDsn: async () => '',  // No DSN in browser mode
  getSentryConfig: async () => ({ dsn: '', tracesSampleRate: 0, profilesSampleRate: 0 }),

  // Spell check (no-op in browser mode)
  setSpellCheckLanguages: async () => ({ success: true, data: { success: true } }),

  getCliToolsInfo: async () => ({
    success: true,
    data: {
      python: { found: false, source: 'fallback' as const, message: 'Not available in browser mode' },
      git: { found: false, source: 'fallback' as const, message: 'Not available in browser mode' },
      gh: { found: false, source: 'fallback' as const, message: 'Not available in browser mode' },
      glab: { found: false, source: 'fallback' as const, message: 'Not available in browser mode' },
      claude: { found: false, source: 'fallback' as const, message: 'Not available in browser mode' }
    }
  }),

  // Claude Code onboarding status (mock - always returns false in browser mode)
  getClaudeCodeOnboardingStatus: async () => ({
    success: true,
    data: { hasCompletedOnboarding: false }
  }),

  // Claude credential (mock - kept in memory, the key is never echoed back)
  getClaudeCredentialStatus: async () => ({ success: true, data: mockCredential }),
  saveClaudeApiKey: async (apiKey: string) => {
    const subscription = apiKey.startsWith('sk-ant-oat');
    const slot = { configured: true, source: 'stored' as const, kind: subscription ? ('subscription-token' as const) : ('api-key' as const), hint: apiKey.trim().slice(-4) };
    mockCredential = { ...mockCredential, ...(subscription ? { subscription: slot } : { api: slot, ...slot }) };
    return { success: true, data: mockCredential };
  },
  clearClaudeApiKey: async (slot?: 'api' | 'subscription') => {
    const empty = { configured: false, source: 'none' as const };
    mockCredential = slot === 'subscription' ? { ...mockCredential, subscription: empty } : { ...mockCredential, ...empty, kind: undefined, hint: undefined, api: empty };
    return { success: true, data: mockCredential };
  },
  testClaudeConnection: async () => ({ success: true, data: { ok: true } }),
  listClaudeModels: async () => ({
    success: true,
    data: {
      endpoint: 'https://api.anthropic.com',
      custom: false,
      fetchedAt: Date.now(),
      models: [
        { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
      ],
    },
  }),

  // App Info
  getAppVersion: async () => '0.1.0-browser',

  // App Update Operations (mock - no updates in browser mode)
  checkAppUpdate: async () => ({ success: true, data: null }),
  downloadAppUpdate: async () => ({ success: true }),
  downloadStableUpdate: async () => ({ success: true }),
  installAppUpdate: () => { console.warn('[browser-mock] installAppUpdate called'); },
  getDownloadedAppUpdate: async () => ({ success: true, data: null }),

  // App Update Event Listeners (no-op in browser mode)
  onAppUpdateAvailable: () => () => {},
  onAppUpdateDownloaded: () => () => {},
  onAppUpdateAutoInstall: () => () => {},
  onSleptWhileRunning: () => () => {},
  postponeAppUpdate: () => {},
  onAppUpdateProgress: () => () => {},
  onAppUpdateStableDowngrade: () => () => {},
  onAppUpdateReadOnlyVolume: () => () => {},
  onAppUpdateError: () => () => {}
};
