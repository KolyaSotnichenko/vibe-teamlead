import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Settings,
  Palette,
  Bot,
  FolderOpen,
  Package,
  Bell,
  Settings2,
  Zap,
  Github,
  Database,
  Sparkles,
  Monitor,
  Globe,
  Code,
  Bug,
  Terminal,
  KeyRound,
  Wrench,
  Send
} from 'lucide-react';

// GitLab icon component (lucide-react doesn't have one)
function GitLabIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" role="img" aria-labelledby="gitlab-icon-title">
      <title id="gitlab-icon-title">GitLab</title>
      <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
    </svg>
  );
}
import {
  FullScreenDialog,
  FullScreenDialogContent,
  FullScreenDialogHeader,
  FullScreenDialogBody,
  FullScreenDialogTitle,
  FullScreenDialogDescription
} from '../ui/full-screen-dialog';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { useSettings } from './hooks/useSettings';
import { ThemeSettings } from './ThemeSettings';
import { DisplaySettings } from './DisplaySettings';
import { LanguageSettings } from './LanguageSettings';
import { GeneralSettings } from './GeneralSettings';
import { AdvancedSettings } from './AdvancedSettings';
import { DevToolsSettings } from './DevToolsSettings';
import { DebugSettings } from './DebugSettings';
import { TerminalFontSettings } from './terminal-font-settings/TerminalFontSettings';
import { MemorySettings } from './MemorySettings';
import { ClaudeSettings } from './ClaudeSettings';
import { ToolsSettings } from './ToolsSettings';
import { TelegramSettings } from './TelegramSettings';
import { ProjectSelector } from './ProjectSelector';
import { ProjectSettingsContent, ProjectSettingsSection } from './ProjectSettingsContent';
import { useProjectStore } from '../../stores/project-store';
import type { UseProjectSettingsReturn } from '../project-settings/hooks/useProjectSettings';

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: AppSection;
  initialProjectSection?: ProjectSettingsSection;
  onRerunWizard?: () => void;
}

// App-level settings sections
export type AppSection = 'appearance' | 'display' | 'language' | 'devtools' | 'terminal-fonts' | 'claude' | 'tools' | 'agent' | 'memory' | 'paths' | 'integrations' | 'updates' | 'notifications' | 'telegram' | 'debug';

interface NavItemConfig<T extends string> {
  id: T;
  icon: React.ElementType;
}

const appNavItemsConfig: NavItemConfig<AppSection>[] = [
  { id: 'appearance', icon: Palette },
  { id: 'display', icon: Monitor },
  { id: 'language', icon: Globe },
  { id: 'devtools', icon: Code },
  { id: 'terminal-fonts', icon: Terminal },
  { id: 'claude', icon: KeyRound },
  { id: 'tools', icon: Wrench },
  { id: 'agent', icon: Bot },
  { id: 'memory', icon: Database },
  { id: 'paths', icon: FolderOpen },
  { id: 'updates', icon: Package },
  { id: 'notifications', icon: Bell },
  { id: 'telegram', icon: Send },
  { id: 'debug', icon: Bug }
];

/** The app-level sections `open-app-settings` can open. */
export const APP_SECTIONS: readonly AppSection[] = appNavItemsConfig.map((item) => item.id);

const projectNavItemsConfig: NavItemConfig<ProjectSettingsSection>[] = [
  { id: 'general', icon: Settings2 },
  { id: 'linear', icon: Zap },
  { id: 'github', icon: Github },
  { id: 'gitlab', icon: GitLabIcon }
];

/**
 * Main application settings dialog container
 * Coordinates app and project settings sections
 */
export function AppSettingsDialog({ open, onOpenChange, initialSection, initialProjectSection, onRerunWizard }: AppSettingsDialogProps) {
  const { t } = useTranslation('settings');
  const {
    settings,
    setSettings,
    error,
    saveSettings,
    hasUnsavedChanges,
    commitTheme,
    discardChanges
  } = useSettings();
  const [version, setVersion] = useState<string>('');

  // Track which top-level section is active
  const [activeTopLevel, setActiveTopLevel] = useState<'app' | 'project'>('app');
  const [appSection, setAppSection] = useState<AppSection>(initialSection || 'appearance');
  const [projectSection, setProjectSection] = useState<ProjectSettingsSection>('general');

  // Autosave: what the header shows, and whether the last close was stopped by a failed save
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const savingRef = useRef(false);

  // Navigate to initial section when dialog opens with a specific section
  useEffect(() => {
    if (open) {
      if (initialProjectSection) {
        setActiveTopLevel('project');
        setProjectSection(initialProjectSection);
      } else if (initialSection) {
        setActiveTopLevel('app');
        setAppSection(initialSection);
      }
    }
  }, [open, initialSection, initialProjectSection]);

  // A fresh open starts with a quiet header
  useEffect(() => {
    if (open) {
      setSaveStatus('idle');
      setProjectError(null);
      setCloseBlocked(false);
    }
  }, [open]);

  // Project state
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectProject = useProjectStore((state) => state.selectProject);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // Project settings hook state (lifted from child)
  const [projectSettingsHook, setProjectSettingsHook] = useState<UseProjectSettingsReturn | null>(null);

  // Load app version on mount
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
  }, []);

  // Memoize the callback to avoid infinite loops
  const handleProjectHookReady = useCallback((hook: UseProjectSettingsReturn | null) => {
    setProjectSettingsHook(hook);
  }, []);

  /**
   * Saves the pending changes: the app settings, and the project settings when the project
   * section is open. Writes nothing when nothing changed. Resolves false when a save failed.
   */
  const savePending = async (): Promise<boolean> => {
    const project = activeTopLevel === 'project' && selectedProject ? projectSettingsHook : null;
    const appChanged = hasUnsavedChanges();
    const projectChanged = project?.hasUnsavedChanges() ?? false;
    if (!appChanged && !projectChanged) return true;

    savingRef.current = true;
    setSaveStatus('saving');
    setProjectError(null);
    let ok = true;
    try {
      if (appChanged) {
        if (await saveSettings()) {
          commitTheme();
        } else {
          ok = false;
        }
      }
      if (projectChanged && project) {
        const result = await project.handleSave();
        if (!result.ok) {
          ok = false;
          setProjectError(result.error);
        }
      }
    } finally {
      savingRef.current = false;
    }
    setSaveStatus(ok ? 'saved' : 'idle');
    if (ok) setCloseBlocked(false);
    return ok;
  };

  /** Leaves the current section once its changes are saved (stays on it when the save fails). */
  const leaveSection = async (next: () => void) => {
    if (savingRef.current) return;
    if (await savePending()) next();
  };

  /**
   * Closing saves. When the save fails the dialog stays open with the error; closing again
   * discards the changes that could not be saved.
   */
  const requestClose = async (): Promise<boolean> => {
    if (savingRef.current) return false;
    if (closeBlocked) {
      discardChanges();
      onOpenChange(false);
      return true;
    }
    if (await savePending()) {
      onOpenChange(false);
      return true;
    }
    setCloseBlocked(true);
    return false;
  };

  const handleProjectChange = (projectId: string | null) => {
    void leaveSection(() => selectProject(projectId));
  };

  const renderAppSection = () => {
    switch (appSection) {
      case 'appearance':
        return <ThemeSettings settings={settings} onSettingsChange={setSettings} />;
      case 'display':
        return <DisplaySettings settings={settings} onSettingsChange={setSettings} />;
      case 'language':
        return <LanguageSettings settings={settings} onSettingsChange={setSettings} />;
      case 'devtools':
        return <DevToolsSettings settings={settings} onSettingsChange={setSettings} />;
      case 'terminal-fonts':
        return <TerminalFontSettings />;
      case 'agent':
        return <GeneralSettings settings={settings} onSettingsChange={setSettings} section="agent" />;
      case 'memory':
        return <MemorySettings settings={settings} onSettingsChange={setSettings} />;
      case 'paths':
        return <GeneralSettings settings={settings} onSettingsChange={setSettings} section="paths" />;
      case 'claude':
        return <ClaudeSettings settings={settings} onSettingsChange={setSettings} />;
      case 'tools':
        return <ToolsSettings />;
      case 'updates':
        return <AdvancedSettings settings={settings} onSettingsChange={setSettings} section="updates" version={version} />;
      case 'notifications':
        return <AdvancedSettings settings={settings} onSettingsChange={setSettings} section="notifications" version={version} />;
      case 'telegram':
        return <TelegramSettings />;
      case 'debug':
        return <DebugSettings />;
      default:
        return null;
    }
  };

  const renderContent = () => {
    if (activeTopLevel === 'app') {
      return renderAppSection();
    }
    return (
      <ProjectSettingsContent
        project={selectedProject}
        activeSection={projectSection}
        isOpen={open}
        onHookReady={handleProjectHookReady}
      />
    );
  };

  // Determine if project nav items should be disabled
  const projectNavDisabled = !selectedProjectId;

  return (
    <FullScreenDialog open={open} onOpenChange={(newOpen) => {
      if (newOpen) {
        onOpenChange(true);
      } else {
        // X, Escape or a click outside: save, then close
        void requestClose();
      }
    }}>
      <FullScreenDialogContent>
        <FullScreenDialogHeader>
          <div className="flex items-start gap-4 pr-14">
            <div className="min-w-0 flex-1 space-y-1.5">
              <FullScreenDialogTitle className="flex items-center gap-3">
                <Settings className="h-6 w-6" />
                {t('title')}
              </FullScreenDialogTitle>
              <FullScreenDialogDescription>
                {t('tabs.subtitle')}
              </FullScreenDialogDescription>
            </div>
            {/* Autosave state, next to the close control */}
            <div
              role="status"
              aria-live="polite"
              aria-busy={saveStatus === 'saving'}
              className="pt-1 font-mono text-xs text-muted-foreground whitespace-nowrap"
            >
              {saveStatus === 'saving' && t('autosave.saving')}
              {saveStatus === 'saved' && !(error || projectError) && t('autosave.saved')}
            </div>
          </div>
          {(error || projectError) && (
            <div role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">
              <p>{t('autosave.failed', { error: error || projectError })}</p>
              {closeBlocked && <p>{t('autosave.closeAgainToDiscard')}</p>}
            </div>
          )}
        </FullScreenDialogHeader>

        <FullScreenDialogBody>
          <div className="flex h-full">
            {/* Navigation sidebar */}
            <nav className="w-80 border-r border-border bg-muted/30 p-4">
              <ScrollArea className="h-full">
                <div className="space-y-6">
                  {/* APPLICATION Section */}
                  <div>
                    <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('tabs.app')}
                    </h3>
                    <div className="space-y-1">
                      {appNavItemsConfig.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeTopLevel === 'app' && appSection === item.id;
                        return (
                          <button
                            key={item.id}
                            onClick={() => {
                              void leaveSection(() => {
                                setActiveTopLevel('app');
                                setAppSection(item.id);
                              });
                            }}
                            className={cn(
                              'w-full flex items-start gap-3 p-3 rounded-lg text-left transition-all',
                              isActive
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                            )}
                          >
                            <Icon className="h-5 w-5 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-sm">{t(`sections.${item.id}.title`)}</div>
                              <div className="text-xs text-muted-foreground truncate">{t(`sections.${item.id}.description`)}</div>
                            </div>
                          </button>
                        );
                      })}

                      {/* Re-run Wizard button */}
                      {onRerunWizard && (
                        <button
                          onClick={() => {
                            void requestClose().then((closed) => {
                              if (closed) onRerunWizard();
                            });
                          }}
                          className={cn(
                            'w-full flex items-start gap-3 p-3 rounded-lg text-left transition-all mt-2',
                            'border border-dashed border-muted-foreground/30',
                            'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                          )}
                        >
                          <Sparkles className="h-5 w-5 mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="font-medium text-sm">{t('actions.rerunWizard')}</div>
                            <div className="text-xs text-muted-foreground truncate">{t('actions.rerunWizardDescription')}</div>
                          </div>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* PROJECT Section */}
                  <div>
                    <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('tabs.project')}
                    </h3>

                    {/* Project Selector */}
                    <div className="px-1 mb-3">
                      <ProjectSelector
                        selectedProjectId={selectedProjectId}
                        onProjectChange={handleProjectChange}
                      />
                    </div>

                    {/* Project Nav Items */}
                    <div className="space-y-1">
                      {projectNavItemsConfig.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeTopLevel === 'project' && projectSection === item.id;
                        return (
                          <button
                            key={item.id}
                            onClick={() => {
                              void leaveSection(() => {
                                setActiveTopLevel('project');
                                setProjectSection(item.id);
                              });
                            }}
                            disabled={projectNavDisabled}
                            className={cn(
                              'w-full flex items-start gap-3 p-3 rounded-lg text-left transition-all',
                              isActive
                                ? 'bg-accent text-accent-foreground'
                                : projectNavDisabled
                                  ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                                  : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                            )}
                          >
                            <Icon className="h-5 w-5 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-sm">{t(`projectSections.${item.id}.title`)}</div>
                              <div className="text-xs text-muted-foreground truncate">{t(`projectSections.${item.id}.description`)}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Version at bottom */}
                {version && (
                  <div className="mt-8 pt-4 border-t border-border">
                    <p className="text-xs text-muted-foreground text-center">
                      {t('updates.version')} {version}
                    </p>
                  </div>
                )}
              </ScrollArea>
            </nav>

            {/* Main content */}
            <div className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className={appSection === 'terminal-fonts' ? 'p-8' : 'p-8 max-w-2xl'}>
                  {renderContent()}
                </div>
              </ScrollArea>
            </div>
          </div>
        </FullScreenDialogBody>

      </FullScreenDialogContent>
    </FullScreenDialog>
  );
}
