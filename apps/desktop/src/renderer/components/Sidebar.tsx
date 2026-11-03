import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Settings,
  LayoutGrid,
  Terminal,
  Map as MapIcon,
  BookOpen,
  Lightbulb,
  Github,
  GitlabIcon,
  GitPullRequest,
  GitMerge,
  FileText,
  Sparkles,
  GitBranch,
  HelpCircle,
  Wrench,
  PanelLeft,
  PanelLeftClose,
  FileInput
} from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from './ui/tooltip';
import { cn } from '../lib/utils';
import {
  useProjectStore,
} from '../stores/project-store';
import { useSettingsStore, saveSettings } from '../stores/settings-store';
import {
  useProjectEnvStore,
  loadProjectEnvConfig,
  clearProjectEnvConfig
} from '../stores/project-env-store';
import { GitSetupModal } from './GitSetupModal';

import { UpdateBanner } from './UpdateBanner';
import { TeamStatus } from './sidebar/TeamStatus';
import { BriefImportDialog } from './brief-import';
import type { GitStatus } from '../../shared/types';

export type SidebarView = 'kanban' | 'terminals' | 'roadmap' | 'context' | 'ideation' | 'github-issues' | 'gitlab-issues' | 'github-prs' | 'gitlab-merge-requests' | 'changelog' | 'insights' | 'worktrees' | 'agent-tools';

interface SidebarProps {
  onSettingsClick: () => void;
  onNewTaskClick: () => void;
  activeView?: SidebarView;
  onViewChange?: (view: SidebarView) => void;
}

interface NavItem {
  id: SidebarView;
  labelKey: string;
  icon: React.ElementType;
  shortcut?: string;
  /** Purpose group in the sidebar */
  group: 'build' | 'plan' | 'knowledge';
}

const NAV_GROUPS = ['build', 'plan', 'knowledge'] as const;

const baseNavItems: NavItem[] = [
  { id: 'kanban', labelKey: 'navigation:items.kanban', icon: LayoutGrid, shortcut: 'K', group: 'build' },
  { id: 'terminals', labelKey: 'navigation:items.terminals', icon: Terminal, shortcut: 'A', group: 'build' },
  { id: 'worktrees', labelKey: 'navigation:items.worktrees', icon: GitBranch, shortcut: 'W', group: 'build' },
  { id: 'roadmap', labelKey: 'navigation:items.roadmap', icon: MapIcon, shortcut: 'D', group: 'plan' },
  { id: 'ideation', labelKey: 'navigation:items.ideation', icon: Lightbulb, shortcut: 'I', group: 'plan' },
  { id: 'insights', labelKey: 'navigation:items.insights', icon: Sparkles, shortcut: 'N', group: 'plan' },
  { id: 'context', labelKey: 'navigation:items.context', icon: BookOpen, shortcut: 'C', group: 'knowledge' },
  { id: 'changelog', labelKey: 'navigation:items.changelog', icon: FileText, shortcut: 'L', group: 'knowledge' },
  { id: 'agent-tools', labelKey: 'navigation:items.agentTools', icon: Wrench, shortcut: 'M', group: 'knowledge' }
];

const githubNavItems: NavItem[] = [
  { id: 'github-issues', labelKey: 'navigation:items.githubIssues', icon: Github, shortcut: 'G', group: 'build' },
  { id: 'github-prs', labelKey: 'navigation:items.githubPRs', icon: GitPullRequest, shortcut: 'P', group: 'build' }
];

const gitlabNavItems: NavItem[] = [
  { id: 'gitlab-issues', labelKey: 'navigation:items.gitlabIssues', icon: GitlabIcon, shortcut: 'B', group: 'build' },
  { id: 'gitlab-merge-requests', labelKey: 'navigation:items.gitlabMRs', icon: GitMerge, shortcut: 'R', group: 'build' }
];

/** Brand mark: the team as a grid of agents, drawn in paper on ink. */
/**
 * "Raised hand": four agents in a row; the one with its hand up (signal) has a
 * question for you. Bars use the surface's foreground, so the mark works on the
 * ink sidebar and on paper.
 */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Vibe Teamlead" className={cn('text-foreground', className)}>
      <title>Vibe Teamlead</title>
      <rect x="3" y="9" width="3" height="12" fill="currentColor" />
      <rect x="8" y="9" width="3" height="12" fill="currentColor" />
      <rect x="13" y="8" width="3" height="13" fill="currentColor" />
      <rect x="18" y="9" width="3" height="12" fill="currentColor" />
      <rect x="13" y="3" width="3" height="5" fill="var(--vt-signal-on-dark)" />
    </svg>
  );
}

export function Sidebar({
  onSettingsClick,
  onNewTaskClick,
  activeView = 'kanban',
  onViewChange
}: SidebarProps) {
  const { t } = useTranslation(['navigation', 'dialogs', 'common']);
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  // The project New Task creates in (App passes the same choice to TaskCreationWizard)
  const taskProjectId = useProjectStore((state) => state.activeProjectId || state.selectedProjectId);
  const settings = useSettingsStore((state) => state.settings);

  const [showGitSetupModal, setShowGitSetupModal] = useState(false);
  const [showBriefImport, setShowBriefImport] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const canCreateTasks = !!selectedProjectId && !!selectedProject?.autoBuildPath;

  // Sidebar collapsed state from settings
  const isCollapsed = settings.sidebarCollapsed ?? false;

  const toggleSidebar = () => {
    saveSettings({ sidebarCollapsed: !isCollapsed });
  };

  // Subscribe to project-env-store for reactive GitHub/GitLab tab visibility
  const githubEnabled = useProjectEnvStore((state) => state.envConfig?.githubEnabled ?? false);
  const gitlabEnabled = useProjectEnvStore((state) => state.envConfig?.gitlabEnabled ?? false);

  // Track the last loaded project ID to avoid redundant loads
  const lastLoadedProjectIdRef = useRef<string | null>(null);

  // Compute visible nav items based on GitHub/GitLab enabled state from store
  const visibleNavItems = useMemo(() => {
    const items = [...baseNavItems];

    if (githubEnabled) {
      items.push(...githubNavItems);
    }

    if (gitlabEnabled) {
      items.push(...gitlabNavItems);
    }

    return items;
  }, [githubEnabled, gitlabEnabled]);

  // Load envConfig when project changes to ensure store is populated
  useEffect(() => {
    // Track whether this effect is still current (for race condition handling)
    let isCurrent = true;

    const initializeEnvConfig = async () => {
      if (selectedProject?.id && selectedProject?.autoBuildPath) {
        // Only reload if the project ID differs from what we last loaded
        if (selectedProject.id !== lastLoadedProjectIdRef.current) {
          lastLoadedProjectIdRef.current = selectedProject.id;
          await loadProjectEnvConfig(selectedProject.id);
          // Check if this effect was cancelled while loading
          if (!isCurrent) return;
        }
      } else {
        // Clear the store if no project is selected or has no autoBuildPath
        lastLoadedProjectIdRef.current = null;
        clearProjectEnvConfig();
      }
    };
    initializeEnvConfig();

    // Cleanup function to mark this effect as stale
    return () => {
      isCurrent = false;
    };
  }, [selectedProject?.id, selectedProject?.autoBuildPath]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      // Not behind an open dialog, and not when another handler took the key
      if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return;

      // Only handle shortcuts when a project is selected
      if (!selectedProjectId) return;

      // Check for modifier keys - we want plain key presses only
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toUpperCase();

      // Find matching nav item from visible items only
      const matchedItem = visibleNavItems.find((item) => item.shortcut === key);

      if (matchedItem) {
        e.preventDefault();
        onViewChange?.(matchedItem.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedProjectId, onViewChange, visibleNavItems]);

  // Check git status when the selected project (not just the project list) changes
  const selectedProjectPath = selectedProject?.path;
  useEffect(() => {
    if (!selectedProjectPath) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    window.electronAPI
      .checkGitStatus(selectedProjectPath)
      .then((result) => {
        if (cancelled || !result.success || !result.data) return;
        setGitStatus(result.data);
        // Offer git setup if the project is not a git repo or has no commits
        if (!result.data.isGitRepo || !result.data.hasCommits) setShowGitSetupModal(true);
      })
      .catch((error) => console.error('Failed to check git status:', error));
    return () => {
      cancelled = true;
    };
  }, [selectedProjectPath]);

  const handleGitInitialized = async () => {
    // Refresh git status after initialization
    if (selectedProject) {
      try {
        const result = await window.electronAPI.checkGitStatus(selectedProject.path);
        if (result.success && result.data) {
          setGitStatus(result.data);
        }
      } catch (error) {
        console.error('Failed to refresh git status:', error);
      }
    }
  };



  const handleNavClick = (view: SidebarView) => {
    onViewChange?.(view);
  };

  const renderNavItem = (item: NavItem) => {
    const isActive = activeView === item.id;
    const Icon = item.icon;

    const button = (
      <button
        type="button"
        key={item.id}
        onClick={() => handleNavClick(item.id)}
        disabled={!selectedProjectId}
        aria-keyshortcuts={item.shortcut}
        className={cn(
          // DESIGN-SYSTEM sidebar item: muted on ink; active = ink-hover fill,
          // paper text and a 2px vermilion mark on the left.
          'group relative flex w-full min-h-10 items-center text-sm text-sidebar-foreground transition-colors',
          'hover:bg-accent hover:text-foreground focus-visible:text-foreground',
          'disabled:pointer-events-none disabled:opacity-40',
          isActive && "bg-accent text-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--vt-signal)] before:content-['']",
          isCollapsed ? 'justify-center px-2' : 'gap-3 px-4'
        )}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        {!isCollapsed && (
          <>
            <span className="flex-1 text-left">{t(item.labelKey)}</span>
            {item.shortcut && (
              <kbd className="pointer-events-none font-mono text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {item.shortcut}
              </kbd>
            )}
          </>
        )}
      </button>
    );

    // Wrap in tooltip when collapsed
    if (isCollapsed) {
      return (
        <Tooltip key={item.id}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right">
            <span>{t(item.labelKey)}</span>
            {item.shortcut && (
              <kbd className="ml-2 rounded border border-border bg-secondary px-1 font-mono text-[10px]">
                {item.shortcut}
              </kbd>
            )}
          </TooltipContent>
        </Tooltip>
      );
    }

    return button;
  };

  // Second way to create tasks: a brief → reviewed tasks. Secondary (1px frame) under New Task.
  const importBriefButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setShowBriefImport(true)}
          disabled={!canCreateTasks}
          className={cn(
            "flex min-h-11 items-center justify-center gap-2 border border-input text-sm font-medium text-foreground hover:bg-accent disabled:opacity-40",
            isCollapsed ? "w-11" : "w-full px-3"
          )}
          aria-label={t('actions.importBrief')}
        >
          <FileInput className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {!isCollapsed && <span className="truncate">{t('actions.importBrief')}</span>}
        </button>
      </TooltipTrigger>
      {isCollapsed && <TooltipContent side="right">{t('actions.importBrief')}</TooltipContent>}
    </Tooltip>
  );

  return (
    <TooltipProvider>
      <div className={cn(
        "vt-ink-surface flex h-full flex-col bg-sidebar text-foreground border-r border-border transition-[width] duration-200",
        isCollapsed ? "w-[72px]" : "w-60"
      )}>
        {/* Brand + collapse; top padding clears the macOS traffic lights */}
        <div className={cn(
          "electron-drag flex items-center pt-9 pb-3",
          isCollapsed ? "flex-col gap-3 px-2" : "gap-3 px-4"
        )}>
          <BrandMark className="h-6 w-6 shrink-0" />
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-foreground">Vibe Teamlead</p>
              {selectedProject && (
                <p className="truncate font-mono text-xs text-muted-foreground" title={selectedProject.path}>
                  {selectedProject.name}
                </p>
              )}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="electron-no-drag flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={toggleSidebar}
                aria-label={isCollapsed ? t('actions.expandSidebar') : t('actions.collapseSidebar')}
              >
                {isCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {isCollapsed ? t('actions.expandSidebar') : t('actions.collapseSidebar')}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* What the team is doing right now */}
        <TeamStatus projectId={selectedProjectId} collapsed={isCollapsed} />

        {/* Navigation, grouped by purpose */}
        <ScrollArea className="mt-4 flex-1">
          <nav className="pb-4">
            {NAV_GROUPS.map((group) => {
              const items = visibleNavItems.filter((item) => item.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className={cn("border-t border-border", isCollapsed ? "pt-2 pb-2" : "pt-3 pb-2")}>
                  {!isCollapsed && (
                    <h3 className="px-4 pb-1.5 text-xs text-muted-foreground">{t(`sections.${group}`)}</h3>
                  )}
                  {items.map(renderNavItem)}
                </div>
              );
            })}
          </nav>
        </ScrollArea>

        {/* Update Banner - shows when app update is available */}
        <UpdateBanner />

        {/* New task + settings/help; import brief below */}
        <div className={cn("border-t border-border", isCollapsed ? "space-y-1 p-2" : "space-y-1 p-3")}>
          <div className={cn("flex", isCollapsed ? "flex-col gap-1" : "items-stretch gap-1")}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onNewTaskClick}
                  disabled={!canCreateTasks}
                  className={cn(
                    "flex min-h-11 items-center justify-center gap-2 bg-primary text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40",
                    isCollapsed ? "w-11" : "flex-1 px-3"
                  )}
                  aria-label={t('actions.newTask')}
                >
                  <Plus className="h-4 w-4" />
                  {!isCollapsed && t('actions.newTask')}
                </button>
              </TooltipTrigger>
              {isCollapsed && <TooltipContent side="right">{t('actions.newTask')}</TooltipContent>}
            </Tooltip>
            {isCollapsed && importBriefButton}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onSettingsClick}
                  aria-label={t('actions.settings')}
                  className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Settings className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side={isCollapsed ? "right" : "top"}>{t('tooltips.settings')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => window.open('https://github.com/KolyaSotnichenko/vibe-teamlead/issues', '_blank')}
                  aria-label={t('tooltips.help')}
                  className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side={isCollapsed ? "right" : "top"}>{t('tooltips.help')}</TooltipContent>
            </Tooltip>
          </div>
          {!isCollapsed && importBriefButton}
          {!isCollapsed && selectedProject && !selectedProject.autoBuildPath && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('messages.initializeToCreateTasks')}
            </p>
          )}
        </div>
      </div>

      {taskProjectId && (
        <BriefImportDialog
          projectId={taskProjectId}
          open={showBriefImport}
          onOpenChange={setShowBriefImport}
          onShowOnBoard={() => onViewChange?.('kanban')}
        />
      )}

      {/* Git Setup Modal */}
      <GitSetupModal
        open={showGitSetupModal}
        onOpenChange={setShowGitSetupModal}
        project={selectedProject || null}
        gitStatus={gitStatus}
        onGitInitialized={handleGitInitialized}
      />
    </TooltipProvider>
  );
}
