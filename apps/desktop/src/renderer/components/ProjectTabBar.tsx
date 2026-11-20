import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { SortableProjectTab } from './SortableProjectTab';
import { ProjectUsage } from './ProjectUsage';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import type { Project } from '../../shared/types';

interface ProjectTabBarProps {
  projects: Project[];
  activeProjectId: string | null;
  onProjectSelect: (projectId: string) => void;
  onProjectClose: (projectId: string) => void;
  onAddProject: () => void;
  className?: string;
  // Control props for active tab
  onSettingsClick?: () => void;
  /** Reload the board's tasks; given only while the board is the page shown */
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function ProjectTabBar({
  projects,
  activeProjectId,
  onProjectSelect,
  onProjectClose,
  onAddProject,
  className,
  onSettingsClick,
  onRefresh,
  isRefreshing
}: ProjectTabBarProps) {
  const { t } = useTranslation(['common', 'tasks']);

  // Keyboard shortcuts for tab navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if in input fields (but NOT xterm's hidden textarea —
      // xterm already passes through Cmd/Ctrl+1-9 via attachCustomKeyEventHandler)
      const target = e.target as HTMLElement;
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');
      if (
        !isXtermTextarea &&
        (e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        target?.isContentEditable)
      ) {
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      // Cmd/Ctrl + 1-9: Switch to tab N
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key, 10) - 1;
        if (index < projects.length) {
          onProjectSelect(projects[index].id);
        }
        return;
      }

      // Cmd/Ctrl + Tab: Next tab
      // Cmd/Ctrl + Shift + Tab: Previous tab
      if (e.key === 'Tab') {
        e.preventDefault();
        const currentIndex = projects.findIndex((p) => p.id === activeProjectId);
        if (currentIndex === -1 || projects.length === 0) return;

        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + projects.length) % projects.length
          : (currentIndex + 1) % projects.length;
        onProjectSelect(projects[nextIndex].id);
        return;
      }

      // Cmd/Ctrl + W: Close current tab (only if more than one tab)
      if (e.key === 'w' && activeProjectId && projects.length > 1) {
        e.preventDefault();
        onProjectClose(activeProjectId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projects, activeProjectId, onProjectSelect, onProjectClose]);

  if (projects.length === 0) {
    return null;
  }

  return (
    <div className={cn(
      // The strip is a window drag area (macOS hiddenInset title bar); tabs opt out below
      'electron-drag flex items-center border-b border-border bg-background',
      'overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent',
      className
    )}>
      <div className="flex items-center flex-1 min-w-0">
        {projects.map((project, index) => {
          const isActiveTab = activeProjectId === project.id;
          return (
            <SortableProjectTab
              key={project.id}
              project={project}
              isActive={isActiveTab}
              canClose={projects.length > 1}
              tabIndex={index}
              onSelect={() => onProjectSelect(project.id)}
              onClose={(e) => {
                e.stopPropagation();
                onProjectClose(project.id);
              }}
              // Pass control props only for active tab
              onSettingsClick={isActiveTab ? onSettingsClick : undefined}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-1 px-2 py-1">
        {/* An icon here instead of a row of its own above the board's columns */}
        {onRefresh && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="electron-no-drag h-8 w-8"
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  aria-label={isRefreshing ? t('common:buttons.refreshing') : t('tasks:refreshTasks')}
                >
                  <RefreshCw aria-hidden className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="font-mono text-xs">
                {isRefreshing ? t('common:buttons.refreshing') : t('tasks:refreshTasks')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <ProjectUsage projectId={activeProjectId} />
        <Button
          variant="ghost"
          size="icon"
          className="electron-no-drag h-8 w-8"
          onClick={onAddProject}
          aria-label={t('projectTab.addProjectAriaLabel')}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
