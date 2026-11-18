/**
 * The status bar: one thin line along the bottom of the window, under the sidebar and the page.
 * Left: live state at a glance (questions waiting, tasks running and queued, the queue pause, CI on
 * main), each opening where it lives. Right: the Knowledge pages and Settings.
 * Only what needs the user is vermilion; everything else stays muted.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { CircleDot, GitBranch, ListOrdered, MessageCircleQuestion, Pause, Settings } from 'lucide-react';

import { cn } from '../../lib/utils';
import { useAgentQuestionsStore } from '../../stores/agent-questions-store';
import { useProjectStore } from '../../stores/project-store';
import { useQueuePauseStore } from '../../stores/queue-pause-store';
import { useTaskStore } from '../../stores/task-store';
import type { ReadinessState } from '../../../shared/types/deploy';
import type { Project } from '../../../shared/types';
import { isCiSetUp } from '../deploy/useDeployEnv';
import type { SidebarView } from '../Sidebar';
import { countTeam } from '../sidebar/TeamStatus';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { KNOWLEDGE_ITEMS } from './knowledge-items';
import { statusItems, type StatusItem } from './status-model';

interface StatusBarProps {
  activeView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  onSettingsClick: () => void;
}

const ICONS: Record<StatusItem['key'], React.ElementType> = {
  waiting: MessageCircleQuestion,
  running: CircleDot,
  queued: ListOrdered,
  paused: Pause,
  ci: GitBranch,
};

/**
 * The conclusion of the last CI run on main, as the CI readiness check recorded it: read once from
 * main and followed through its updates. Never starts a scan or asks GitHub.
 */
function useMainCiConclusion(project: Project | undefined): string | null {
  const projectId = project && isCiSetUp(project.settings?.deploy) ? project.id : null;
  const [seen, setSeen] = useState<{ projectId: string; conclusion: string | null } | null>(null);

  useEffect(() => {
    const deploy = window.electronAPI?.deploy;
    if (!projectId || !deploy) return;
    let cancelled = false;
    const take = (state: ReadinessState | undefined) =>
      setSeen({ projectId, conclusion: state?.result?.workflow?.lastMainRun?.conclusion ?? null });
    Promise.resolve(deploy.readinessState?.(projectId))
      .then((r) => {
        if (!cancelled && r?.success) take(r.data);
      })
      .catch(() => undefined);
    const off = deploy.onReadinessUpdate?.((update) => {
      if (update.projectId === projectId) take(update.state);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [projectId]);

  return projectId && seen?.projectId === projectId ? seen.conclusion : null;
}

export function StatusBar({ activeView, onViewChange, onSettingsClick }: StatusBarProps) {
  const { t } = useTranslation(['navigation']);
  const projectId = useProjectStore((s) => s.selectedProjectId);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === s.selectedProjectId));
  const counts = useTaskStore(
    useShallow((s) => countTeam(projectId ? s.tasks.filter((task) => task.projectId === projectId).map((task) => task.status) : []))
  );
  const paused = useQueuePauseStore((s) => s.paused);
  const pending = useAgentQuestionsStore((s) => s.pending);
  const openQuestion = useAgentQuestionsStore((s) => s.open);
  const ciConclusion = useMainCiConclusion(project);

  const waiting = pending.filter((q) => !projectId || !q.projectId || q.projectId === projectId);
  const items = statusItems({
    hasProject: !!project,
    working: counts.working,
    queued: counts.queued,
    paused,
    waiting: waiting.length,
    ciConclusion,
  });

  const go = (item: StatusItem) => {
    if (item.target === 'question') openQuestion(waiting[0]?.questionId ?? null);
    else if (item.target === 'ci') window.dispatchEvent(new CustomEvent('open-deploy', { detail: { tab: 'readiness' } }));
    else onViewChange('kanban');
  };

  const label = (item: StatusItem) => {
    if (item.key === 'ci') return t(`statusBar.ci.${item.ci}`);
    if (item.key === 'paused') return t('statusBar.paused');
    return t(`statusBar.${item.key}`, { count: item.count });
  };

  const hint = (item: StatusItem) =>
    t(item.target === 'question' ? 'statusBar.openQuestion' : item.target === 'ci' ? 'statusBar.openCi' : 'statusBar.openBoard');

  const itemClass = 'flex h-6 shrink-0 items-center gap-1.5 px-2 hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

  return (
    <TooltipProvider>
      <footer className="vt-ink-surface flex h-6 shrink-0 items-stretch justify-between overflow-hidden border-t border-border bg-sidebar text-xs text-muted-foreground">
        <div className="flex min-w-0 items-stretch overflow-hidden">
          {items.map((item) => {
            const Icon = ICONS[item.key];
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-alert={item.alert ? 'true' : undefined}
                    onClick={() => go(item)}
                    className={cn(itemClass, item.alert && 'text-[var(--vt-signal-on-dark)] hover:text-[var(--vt-signal-on-dark)]')}
                  >
                    {item.alert ? (
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-[var(--vt-signal-on-dark)]" />
                    ) : (
                      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                    )}
                    <span className="whitespace-nowrap">{label(item)}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-mono text-xs">{hint(item)}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <nav className="flex shrink-0 items-stretch">
          {KNOWLEDGE_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            const text = t(item.labelKey);
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onViewChange(item.id)}
                    // Documentation works without a project
                    disabled={!project && item.id !== 'docs'}
                    aria-label={text}
                    aria-keyshortcuts={item.shortcut}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      itemClass,
                      'relative disabled:pointer-events-none disabled:opacity-40',
                      // Active like the sidebar's item: ink-hover fill, paper text, a 2px vermilion mark
                      isActive && "bg-accent text-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-[var(--vt-signal)] before:content-['']"
                    )}
                  >
                    <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                    {/* Labels give way to icons on narrow windows; the tooltip still names the page */}
                    <span className="hidden whitespace-nowrap lg:inline">{text}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-mono text-xs">
                  {text}
                  <kbd className="ml-2 font-mono text-[10px] text-muted-foreground">{item.shortcut}</kbd>
                </TooltipContent>
              </Tooltip>
            );
          })}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onSettingsClick} aria-label={t('tooltips.settings')} className={itemClass}>
                <Settings aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="font-mono text-xs">{t('tooltips.settings')}</TooltipContent>
          </Tooltip>
        </nav>
      </footer>
    </TooltipProvider>
  );
}
