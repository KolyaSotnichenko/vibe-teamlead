import { create } from 'zustand';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_APP_SETTINGS } from '../../shared/constants';
import { markSettingsLoaded } from '../lib/sentry';
import { invalidateEndpointModels } from '../hooks/useEndpointModels';

interface SettingsState {
  settings: AppSettings;
  isLoading: boolean;
  error: string | null;

  // Actions
  setSettings: (settings: AppSettings) => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_APP_SETTINGS as AppSettings,
  isLoading: true,  // Start as true since we load settings on app init
  error: null,

  setSettings: (settings) => set({ settings }),

  updateSettings: (updates) =>
    set((state) => ({
      settings: { ...state.settings, ...updates }
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),
}));

/**
 * Settings saved before the onboarding flag existed: someone who already
 * saved a Claude credential has set the app up and skips the wizard.
 * Claude Code's own ~/.claude.json is not a sign of that — the app runs
 * Claude Code with its own config — and neither is the prompts path.
 */
async function migrateOnboardingCompleted(settings: AppSettings): Promise<AppSettings> {
  // Only migrate if onboardingCompleted is undefined (not explicitly set)
  if (settings.onboardingCompleted !== undefined) {
    return settings;
  }

  try {
    const status = await window.electronAPI.getClaudeCredentialStatus();
    if (status.success && status.data?.configured === true) {
      return { ...settings, onboardingCompleted: true };
    }
  } catch {
    // Treat as not configured
  }

  // New user - set to false to trigger onboarding wizard
  return { ...settings, onboardingCompleted: false };
}

/**
 * Load settings from main process
 */
export async function loadSettings(): Promise<void> {
  const store = useSettingsStore.getState();
  store.setLoading(true);

  try {
    const result = await window.electronAPI.getSettings();
    if (result.success && result.data) {
      // Apply migration for onboardingCompleted flag
      // This is now async since it needs to read ~/.claude.json
      const migratedSettings = await migrateOnboardingCompleted(result.data);
      store.setSettings(migratedSettings);

      // If migration changed the settings, persist them
      if (migratedSettings.onboardingCompleted !== result.data.onboardingCompleted) {
        await window.electronAPI.saveSettings({
          onboardingCompleted: migratedSettings.onboardingCompleted
        });
      }

      // Only mark settings as loaded on SUCCESS
      // This ensures Sentry respects user's opt-out preference even if settings fail to load
      // (If settings fail to load, Sentry's beforeSend drops all events until successful load)
      markSettingsLoaded();
    }
    // Note: If result.success is false, we intentionally do NOT mark settings as loaded.
    // This means Sentry will drop events, which is the safe default for privacy.
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to load settings');
    // Note: On exception, we intentionally do NOT mark settings as loaded.
    // Sentry's beforeSend will drop events, respecting potential user opt-out.
  } finally {
    store.setLoading(false);
  }
}

/**
 * Save settings to main process
 */
export async function saveSettings(updates: Partial<AppSettings>): Promise<boolean> {
  const store = useSettingsStore.getState();

  try {
    const result = await window.electronAPI.saveSettings(updates);
    if (result.success) {
      const endpointChanged =
        'anthropicBaseUrl' in updates && updates.anthropicBaseUrl !== store.settings.anthropicBaseUrl;
      store.updateSettings(updates);
      // The model pickers list the models of the configured endpoint
      if (endpointChanged) invalidateEndpointModels();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
