/**
 * @vitest-environment jsdom
 */
/**
 * Settings save by themselves when a section is left or the dialog closes, so a save must
 * write only what was changed, write nothing when nothing was, and keep pending edits when
 * something else (a theme preview, the Claude mode saved at once) updates the store.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../../stores/settings-store';
import { useSettings } from '../hooks/useSettings';
import type { AppSettings } from '../../../../shared/types';
import i18n from '../../../../shared/i18n';

const saveSettingsIpc = vi.fn(async (_updates: Partial<AppSettings>) => ({ success: true }));

beforeEach(() => {
  saveSettingsIpc.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    saveSettings: saveSettingsIpc,
    getSettings: vi.fn(async () => ({ success: false })),
  };
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, theme: 'light', anthropicBaseUrl: undefined, autoBuildPath: '/a' } as AppSettings,
  });
});

describe('useSettings autosave', () => {
  it('writes nothing when nothing changed', async () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.hasUnsavedChanges()).toBe(false);
    let ok = false;
    await act(async () => { ok = await result.current.saveSettings(); });
    expect(ok).toBe(true);
    expect(saveSettingsIpc).not.toHaveBeenCalled();
  });

  it('writes only the changed settings, then has nothing left to save', async () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setSettings({ ...result.current.settings, autoBuildPath: '/b' }));
    expect(result.current.hasUnsavedChanges()).toBe(true);
    await act(async () => { await result.current.saveSettings(); });
    expect(saveSettingsIpc).toHaveBeenCalledTimes(1);
    expect(saveSettingsIpc).toHaveBeenCalledWith({ autoBuildPath: '/b' });
    expect(result.current.hasUnsavedChanges()).toBe(false);
  });

  it('keeps a pending edit when the store changes underneath (theme preview)', async () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setSettings({ ...result.current.settings, autoBuildPath: '/b' }));
    act(() => useSettingsStore.getState().updateSettings({ theme: 'dark' }));
    expect(result.current.settings.autoBuildPath).toBe('/b');
    expect(result.current.settings.theme).toBe('dark');
  });

  it('does not write again a setting that was already saved at once (the Claude mode)', async () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setSettings({ ...result.current.settings, useClaudeSubscription: true }));
    act(() => useSettingsStore.getState().updateSettings({ useClaudeSubscription: true }));
    expect(result.current.hasUnsavedChanges()).toBe(false);
  });

  it('still saves a previewed theme, though the store already shows it', async () => {
    const { result } = renderHook(() => useSettings());
    act(() => {
      result.current.setSettings({ ...result.current.settings, theme: 'dark' });
      useSettingsStore.getState().updateSettings({ theme: 'dark' });
    });
    await act(async () => { await result.current.saveSettings(); });
    expect(saveSettingsIpc).toHaveBeenCalledWith({ theme: 'dark' });
  });

  // LanguageSettings shows the new language at once through the store; it was then never written
  it('still saves a previewed language, though the store already shows it', async () => {
    const { result } = renderHook(() => useSettings());
    act(() => {
      result.current.setSettings({ ...result.current.settings, language: 'uk' });
      useSettingsStore.getState().updateSettings({ language: 'uk' });
    });
    expect(result.current.hasUnsavedChanges()).toBe(true);
    await act(async () => { await result.current.saveSettings(); });
    expect(saveSettingsIpc).toHaveBeenCalledWith({ language: 'uk' });
  });

  it('discarding a previewed language goes back to the saved one', () => {
    act(() => useSettingsStore.getState().updateSettings({ language: 'en' }));
    const { result } = renderHook(() => useSettings());
    act(() => {
      result.current.setSettings({ ...result.current.settings, language: 'uk' });
      useSettingsStore.getState().updateSettings({ language: 'uk' });
    });
    act(() => result.current.discardChanges());
    expect(useSettingsStore.getState().settings.language).toBe('en');
    expect(result.current.hasUnsavedChanges()).toBe(false);
  });

  it('reports a failed save and keeps the change pending', async () => {
    saveSettingsIpc.mockResolvedValueOnce({ success: false });
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setSettings({ ...result.current.settings, autoBuildPath: '/b' }));
    let ok = true;
    await act(async () => { ok = await result.current.saveSettings(); });
    expect(ok).toBe(false);
    // In the app's language, not a fixed English string ("Не вдалося зберегти налаштування: Failed to save settings")
    expect(result.current.error).toBe(i18n.t('settings:autosave.notWritten'));
    expect(result.current.error).not.toBe('settings:autosave.notWritten');
    expect(result.current.hasUnsavedChanges()).toBe(true);
  });

  it('discardChanges drops pending edits and reverts the previewed theme', async () => {
    const { result } = renderHook(() => useSettings());
    act(() => {
      result.current.setSettings({ ...result.current.settings, theme: 'dark' });
      useSettingsStore.getState().updateSettings({ theme: 'dark' });
    });
    act(() => result.current.discardChanges());
    expect(result.current.hasUnsavedChanges()).toBe(false);
    expect(useSettingsStore.getState().settings.theme).toBe('light');
  });
});
