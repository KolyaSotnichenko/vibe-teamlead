/**
 * @vitest-environment jsdom
 */
/**
 * Settings save by themselves: leaving a section saves what was changed there, and closing
 * the dialog (X, Escape, a click outside) saves instead of dropping the changes. A user saved
 * a subscription token, closed Settings without pressing Save, and every session then failed
 * with "No Claude credentials configured". A failed save keeps the dialog open with the error.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

const { app, projectHook, projectState } = vi.hoisted(() => ({
  app: {
    settings: {},
    setSettings: vi.fn(),
    isSaving: false,
    error: null as string | null,
    saveSettings: vi.fn(async () => true),
    hasUnsavedChanges: vi.fn(() => false),
    commitTheme: vi.fn(),
    revertTheme: vi.fn(),
    discardChanges: vi.fn(),
  },
  projectHook: {
    isSaving: false,
    error: null,
    envError: null,
    hasUnsavedChanges: vi.fn(() => false),
    handleSave: vi.fn(async () => ({ ok: true, error: null as string | null })),
  },
  projectState: {
    projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    selectedProjectId: 'p1' as string | null,
    selectProject: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { error?: string }) => (opts?.error ? `${key} ${opts.error}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../hooks/useSettings', () => ({ useSettings: () => app }));
vi.mock('../../../stores/project-store', () => ({
  useProjectStore: (select: (s: typeof projectState) => unknown) => select(projectState),
}));
vi.mock('../../ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../ProjectSelector', () => ({
  ProjectSelector: ({ onProjectChange }: { onProjectChange: (id: string) => void }) => (
    <button type="button" onClick={() => onProjectChange('p2')}>pick-p2</button>
  ),
}));
vi.mock('../ProjectSettingsContent', () => ({
  ProjectSettingsContent: ({ onHookReady }: { onHookReady: (hook: unknown) => void }) => {
    useEffect(() => {
      onHookReady(projectHook);
      return () => onHookReady(null);
    }, [onHookReady]);
    return <div>project-content</div>;
  },
}));
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => name }));
vi.mock('../ThemeSettings', () => ({ ThemeSettings: stub('theme-section') }));
vi.mock('../DisplaySettings', () => ({ DisplaySettings: stub('display-section') }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: stub('language-section') }));
vi.mock('../GeneralSettings', () => ({ GeneralSettings: stub('general-section') }));
vi.mock('../AdvancedSettings', () => ({ AdvancedSettings: stub('advanced-section') }));
vi.mock('../DevToolsSettings', () => ({ DevToolsSettings: stub('devtools-section') }));
vi.mock('../DebugSettings', () => ({ DebugSettings: stub('debug-section') }));
vi.mock('../terminal-font-settings/TerminalFontSettings', () => ({ TerminalFontSettings: stub('fonts-section') }));
vi.mock('../MemorySettings', () => ({ MemorySettings: stub('memory-section') }));
vi.mock('../ClaudeSettings', () => ({ ClaudeSettings: stub('claude-section') }));
vi.mock('../ToolsSettings', () => ({ ToolsSettings: stub('tools-section') }));
vi.mock('../TelegramSettings', () => ({ TelegramSettings: stub('telegram-section') }));

import { AppSettingsDialog } from '../AppSettings';

beforeEach(() => {
  vi.clearAllMocks();
  app.error = null;
  app.hasUnsavedChanges.mockReturnValue(false);
  app.saveSettings.mockResolvedValue(true);
  projectHook.hasUnsavedChanges.mockReturnValue(false);
  projectHook.handleSave.mockResolvedValue({ ok: true, error: null });
  projectState.selectedProjectId = 'p1';
  (window as unknown as { electronAPI: unknown }).electronAPI = { getAppVersion: vi.fn(async () => '2.0.0') };
});

function renderDialog(props: Partial<React.ComponentProps<typeof AppSettingsDialog>> = {}) {
  const onOpenChange = vi.fn();
  render(<AppSettingsDialog open onOpenChange={onOpenChange} {...props} />);
  return onOpenChange;
}

const pressEscape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('AppSettingsDialog autosave', () => {
  it('has no Save or Cancel button', () => {
    renderDialog();
    expect(screen.queryByText('actions.save')).toBeNull();
    expect(screen.queryByText('common:buttons.cancel')).toBeNull();
  });

  it('saves the app settings when another app section is opened', async () => {
    app.hasUnsavedChanges.mockReturnValue(true);
    renderDialog();
    fireEvent.click(screen.getByText('sections.display.title'));
    await screen.findByText('display-section');
    expect(app.saveSettings).toHaveBeenCalledTimes(1);
    expect(app.commitTheme).toHaveBeenCalled();
  });

  it('does not write when nothing changed', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('sections.display.title'));
    await screen.findByText('display-section');
    expect(app.saveSettings).not.toHaveBeenCalled();
  });

  it('saves on close instead of reverting, then closes', async () => {
    app.hasUnsavedChanges.mockReturnValue(true);
    const onOpenChange = renderDialog();
    pressEscape();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(app.saveSettings).toHaveBeenCalledTimes(1);
    expect(app.revertTheme).not.toHaveBeenCalled();
    expect(app.discardChanges).not.toHaveBeenCalled();
  });

  it('saves on the close button too', async () => {
    app.hasUnsavedChanges.mockReturnValue(true);
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByText('buttons.close').closest('button') as HTMLElement);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(app.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('stays open with the error when the save fails; closing again discards', async () => {
    app.hasUnsavedChanges.mockReturnValue(true);
    app.saveSettings.mockImplementation(async () => {
      app.error = 'disk full';
      return false;
    });
    const onOpenChange = renderDialog();
    pressEscape();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('disk full');
    expect(alert).toHaveTextContent('autosave.closeAgainToDiscard');
    expect(onOpenChange).not.toHaveBeenCalled();

    pressEscape();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(app.discardChanges).toHaveBeenCalled();
  });

  it('shows that the settings were saved', async () => {
    app.hasUnsavedChanges.mockReturnValue(true);
    renderDialog();
    fireEvent.click(screen.getByText('sections.display.title'));
    expect(await screen.findByText('autosave.saved')).toBeTruthy();
  });

  it('saves project settings when going back to an app section', async () => {
    projectHook.hasUnsavedChanges.mockReturnValue(true);
    renderDialog({ initialProjectSection: 'general' });
    await screen.findByText('project-content');
    fireEvent.click(screen.getByText('sections.display.title'));
    await screen.findByText('display-section');
    expect(projectHook.handleSave).toHaveBeenCalledTimes(1);
  });

  it('keeps the project section open when its save fails', async () => {
    projectHook.hasUnsavedChanges.mockReturnValue(true);
    projectHook.handleSave.mockResolvedValue({ ok: false, error: 'env write failed' });
    renderDialog({ initialProjectSection: 'general' });
    await screen.findByText('project-content');
    fireEvent.click(screen.getByText('sections.display.title'));
    expect(await screen.findByRole('alert')).toHaveTextContent('env write failed');
    expect(screen.getByText('project-content')).toBeTruthy();
  });

  it('saves project settings before another project is selected', async () => {
    projectHook.hasUnsavedChanges.mockReturnValue(true);
    renderDialog({ initialProjectSection: 'general' });
    await screen.findByText('project-content');
    await act(async () => { fireEvent.click(screen.getByText('pick-p2')); });
    await waitFor(() => expect(projectState.selectProject).toHaveBeenCalledWith('p2'));
    expect(projectHook.handleSave).toHaveBeenCalledTimes(1);
    expect(projectHook.handleSave.mock.invocationCallOrder[0])
      .toBeLessThan(projectState.selectProject.mock.invocationCallOrder[0]);
  });

  it('saves project settings when the dialog closes on a project section', async () => {
    projectHook.hasUnsavedChanges.mockReturnValue(true);
    const onOpenChange = renderDialog({ initialProjectSection: 'general' });
    await screen.findByText('project-content');
    pressEscape();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(projectHook.handleSave).toHaveBeenCalledTimes(1);
  });
});
