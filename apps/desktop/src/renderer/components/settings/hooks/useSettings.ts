import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore, saveSettings as saveSettingsToStore, loadSettings as loadSettingsFromStore } from '../../../stores/settings-store';
import type { AppSettings } from '../../../../shared/types';
import i18n from '../../../../shared/i18n';
import { UI_SCALE_DEFAULT } from '../../../../shared/constants';

type SettingsKey = keyof AppSettings;

/** Settings previewed through the store before they are saved. */
const PREVIEW_KEYS = new Set<SettingsKey>(['theme', 'colorTheme', 'uiScale', 'language']);

/**
 * Custom hook for managing application settings in the settings dialog.
 *
 * Edits stay local until saveSettings() runs (the dialog calls it when a section is left or
 * the dialog closes). Only the settings that changed are written, and nothing is written when
 * nothing changed. Theme, UI scale and language are previewed through the store at once; discardChanges()
 * drops the pending edits and reverts that preview.
 */
export function useSettings() {
  const currentSettings = useSettingsStore((state) => state.settings);
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);
  const [settings, setLocalSettings] = useState<AppSettings>(currentSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Latest local settings (callers may save right after an edit, before a re-render)
  const settingsRef = useRef<AppSettings>(currentSettings);
  // Settings edited in the dialog and not yet saved
  const dirtyKeysRef = useRef<Set<SettingsKey>>(new Set());

  // The theme/scale/language before any preview, restored by discardChanges()
  const originalThemeRef = useRef<{
    theme: AppSettings['theme'];
    colorTheme: AppSettings['colorTheme'];
    uiScale: number;
    language: AppSettings['language'];
  }>({
    theme: currentSettings.theme,
    colorTheme: currentSettings.colorTheme,
    uiScale: currentSettings.uiScale ?? UI_SCALE_DEFAULT,
    language: currentSettings.language
  });

  // Follow the store, keeping the edits that are still pending
  useEffect(() => {
    const merged = { ...currentSettings } as Record<SettingsKey, unknown>;
    for (const key of dirtyKeysRef.current) {
      // Saved elsewhere already (the Claude mode is saved when picked); a theme/scale/language
      // preview only shows in the store and still needs saving
      if (!PREVIEW_KEYS.has(key) && currentSettings[key] === settingsRef.current[key]) {
        dirtyKeysRef.current.delete(key);
        continue;
      }
      merged[key] = settingsRef.current[key];
    }
    settingsRef.current = merged as unknown as AppSettings;
    setLocalSettings(settingsRef.current);
    // No preview pending: the stored theme is the one to go back to
    const dirty = dirtyKeysRef.current;
    if (![...PREVIEW_KEYS].some((key) => dirty.has(key))) {
      originalThemeRef.current = {
        theme: currentSettings.theme,
        colorTheme: currentSettings.colorTheme,
        uiScale: currentSettings.uiScale ?? UI_SCALE_DEFAULT,
        language: currentSettings.language
      };
    }
  }, [currentSettings]);

  // Load settings on mount
  useEffect(() => {
    loadSettingsFromStore();
  }, []);

  const setSettings = useCallback((next: AppSettings) => {
    const prev = settingsRef.current;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)] as SettingsKey[]);
    for (const key of keys) {
      if (prev[key] !== next[key]) dirtyKeysRef.current.add(key);
    }
    settingsRef.current = next;
    setLocalSettings(next);
  }, []);

  const hasUnsavedChanges = useCallback(() => dirtyKeysRef.current.size > 0, []);

  const applyTheme = (theme: 'light' | 'dark' | 'system') => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else if (theme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      // System preference
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  };

  /** Saves the pending edits; resolves true when they are saved or there were none. */
  const saveSettings = async (): Promise<boolean> => {
    const keys = [...dirtyKeysRef.current];
    if (keys.length === 0) return true;
    const updates: Partial<AppSettings> = {};
    for (const key of keys) {
      (updates as Record<SettingsKey, unknown>)[key] = settingsRef.current[key];
    }

    setIsSaving(true);
    setError(null);

    try {
      const success = await saveSettingsToStore(updates);
      if (success) {
        // Edits made while the save was in flight stay pending
        for (const key of keys) {
          if (settingsRef.current[key] === updates[key]) dirtyKeysRef.current.delete(key);
        }
        applyTheme(settingsRef.current.theme);
        return true;
      }
      setError(i18n.t('settings:autosave.notWritten'));
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('settings:autosave.unknown'));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const updateSettings = (partial: Partial<AppSettings>) => {
    setSettings({ ...settingsRef.current, ...partial });
  };

  /** Restores the theme/scale/language from before the preview. */
  const revertTheme = useCallback(() => {
    const original = originalThemeRef.current;
    updateStoreSettings({
      theme: original.theme,
      colorTheme: original.colorTheme,
      uiScale: original.uiScale,
      language: original.language
    });
  }, [updateStoreSettings]);

  /** Makes the current theme the one future reverts go back to (after a save). */
  const commitTheme = useCallback(() => {
    const current = settingsRef.current;
    originalThemeRef.current = {
      theme: current.theme,
      colorTheme: current.colorTheme,
      uiScale: current.uiScale ?? UI_SCALE_DEFAULT,
      language: current.language
    };
  }, []);

  /** Drops the pending edits and reverts the theme preview. */
  const discardChanges = useCallback(() => {
    dirtyKeysRef.current.clear();
    setError(null);
    revertTheme();
    const stored = useSettingsStore.getState().settings;
    settingsRef.current = stored;
    setLocalSettings(stored);
  }, [revertTheme]);

  return {
    settings,
    setSettings,
    updateSettings,
    isSaving,
    error,
    saveSettings,
    hasUnsavedChanges,
    applyTheme,
    revertTheme,
    commitTheme,
    discardChanges
  };
}
