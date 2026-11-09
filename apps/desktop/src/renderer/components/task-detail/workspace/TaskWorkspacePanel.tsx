/**
 * Task workspace: Spec / Plan / Architecture views over the task's spec directory.
 * Data comes from TASK_WORKSPACE_GET (parsed in the main process).
 * The Plan tab (graph library) and Mermaid are lazy-loaded.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { RefreshCw } from 'lucide-react';
import type { Task, TaskStorybookStatus, TaskWorkspace } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { ArchitectureTab } from './ArchitectureTab';
import { SecurityTab } from './SecurityTab';
import { SpecTab } from './SpecTab';
import { StorybookTab } from './StorybookTab';
import { PreviewPage } from '../../preview/PreviewPage';
import { useProjectStore } from '../../../stores/project-store';
import { EmptyState } from './workspace-ui';

const PlanTab = lazy(() => import('./PlanTab'));

type Section = 'spec' | 'plan' | 'architecture' | 'security' | 'storybook' | 'preview';

/** The workspace's tabs: Storybook when the worktree has one, Preview while the task waits in review. Pure. */
export function workspaceSections(opts: { storybook: boolean; status: string; hasProject: boolean }): Section[] {
  return [
    'spec', 'plan', 'architecture', 'security',
    ...(opts.storybook ? (['storybook'] as const) : []),
    ...(opts.status === 'human_review' && opts.hasProject ? (['preview'] as const) : []),
  ];
}

function useTaskWorkspace(task: Task) {
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.getTaskWorkspace(task.id, task.projectId);
      if (request !== requestRef.current) return;
      if (result.success) {
        setWorkspace(result.data ?? null);
        setError(null);
      } else {
        setError(result.error ?? 'error');
      }
    } catch (e) {
      if (request === requestRef.current) setError(e instanceof Error ? e.message : 'error');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [task.id, task.projectId]);

  // Re-read when the agents move the task forward (status, phase, subtask progress)
  const progressKey = `${task.status}|${task.executionProgress?.phase ?? ''}|${task.subtasks.map((s) => s.status[0]).join('')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: progressKey is the intended trigger
  useEffect(() => {
    void load();
  }, [load, progressKey]);

  return { workspace, loading, error, reload: load };
}

export function TaskWorkspacePanel({ task }: { task: Task }) {
  const { t } = useTranslation(['tasks']);
  const { workspace, loading, error, reload } = useTaskWorkspace(task);
  const [section, setSection] = useState<Section>('spec');
  const [selectedSubtaskId, setSelectedSubtaskId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Storybook of the task's worktree: the tab appears when the worktree has one
  const [storybook, setStorybook] = useState<TaskStorybookStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.design
      ?.taskStorybookStatus?.(task.id, task.projectId)
      .then((r) => !cancelled && r?.success && r.data && setStorybook(r.data))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, task.status]);
  // The task's own app, before it merges: while it waits in review
  const project = useProjectStore((state) => state.projects.find((p) => p.id === task.projectId));
  const sections = workspaceSections({ storybook: !!(storybook?.worktree && storybook.detected), status: task.status, hasProject: !!project });
  const previewable = sections.includes('preview');

  // Each section starts at its top
  // biome-ignore lint/correctness/useExhaustiveDependencies: section is the intended trigger
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const openSubtask = useCallback((id: string | null) => {
    setSelectedSubtaskId(id);
    if (id) setSection('plan');
  }, []);

  const tabClass = cn(
    'relative inline-flex h-11 items-center px-4 text-sm font-medium text-muted-foreground',
    'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
    'data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'
  );

  const counts = workspace
    ? {
        spec: workspace.spec?.criteria.length,
        plan: workspace.plan?.phases.reduce((n, p) => n + p.subtasks.length, 0),
        architecture: workspace.architecture.diagrams.length + workspace.architecture.adrs.length || undefined,
        security: undefined,
        storybook: undefined,
        preview: undefined,
      }
    : {};
  const failing = workspace?.spec?.criteria.filter((c) => c.status === 'fail').length ?? 0;
  const securityBlocking = workspace
    ? (workspace.security.gates?.findings.length ?? 0) +
      (workspace.security.pentest?.status === 'findings' ? workspace.security.pentest.findings.filter((f) => f.blocking).length : 0)
    : 0;

  return (
    <TabsPrimitive.Root value={section} onValueChange={(v) => setSection(v as Section)} className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
        <TabsPrimitive.List aria-label={t('tasks:workspace.sections.label')} className="inline-flex border border-foreground">
          {sections.map((key, i) => (
            <TabsPrimitive.Trigger key={key} value={key} className={cn(tabClass, i > 0 && 'border-l border-foreground')}>
              {t(`tasks:workspace.tabs.${key}`)}
              {counts[key] !== undefined && <span className="ml-2 font-mono text-[11px] opacity-70">{counts[key]}</span>}
              {key === 'security' && securityBlocking > 0 && (
                <span className="ml-2 inline-flex h-5 items-center bg-destructive px-1.5 font-mono text-[10px] font-semibold text-destructive-foreground">
                  {securityBlocking}
                </span>
              )}
              {key === 'spec' && failing > 0 && (
                <span className="ml-2 inline-flex h-5 items-center bg-destructive px-1.5 font-mono text-[10px] font-semibold text-destructive-foreground">
                  {failing} {t('tasks:workspace.acStatus.fail').toUpperCase()}
                </span>
              )}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        <button
          type="button"
          onClick={() => void reload()}
          aria-label={t('tasks:workspace.refresh')}
          className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw aria-hidden="true" className={cn('h-4 w-4', loading && workspace && 'animate-spin')} />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1100px] px-6 py-6">
          {!workspace && loading ? (
            <div role="status" aria-busy="true" className="flex items-center gap-3 border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
              <span aria-hidden="true" className="vt-breathe h-2 w-2 bg-foreground" />
              {t('tasks:workspace.loading')}
            </div>
          ) : error && !workspace ? (
            <div className="space-y-3">
              <p className="border border-destructive px-4 py-3 text-sm text-destructive">{t('tasks:workspace.loadError')}</p>
              <button
                type="button"
                onClick={() => void reload()}
                className="h-11 border border-foreground px-4 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('tasks:workspace.retry')}
              </button>
            </div>
          ) : !workspace ? (
            <EmptyState title={t('tasks:workspace.noSpecDir.title')} body={t('tasks:workspace.noSpecDir.body')} />
          ) : (
            <>
              <TabsPrimitive.Content value="spec" className="focus-visible:outline-none">
                <SpecTab workspace={workspace} onOpenSubtask={openSubtask} />
              </TabsPrimitive.Content>
              <TabsPrimitive.Content value="plan" className="focus-visible:outline-none">
                <Suspense
                  fallback={
                    <div role="status" aria-busy="true" className="text-sm text-muted-foreground">
                      {t('tasks:workspace.loading')}
                    </div>
                  }
                >
                  <PlanTab workspace={workspace} selectedSubtaskId={selectedSubtaskId} onSelectSubtask={setSelectedSubtaskId} />
                </Suspense>
              </TabsPrimitive.Content>
              <TabsPrimitive.Content value="architecture" className="focus-visible:outline-none">
                <ArchitectureTab workspace={workspace} taskId={task.id} projectId={task.projectId} />
              </TabsPrimitive.Content>
              <TabsPrimitive.Content value="security" className="focus-visible:outline-none">
                <SecurityTab workspace={workspace} />
              </TabsPrimitive.Content>
              {storybook?.detected && (
                <TabsPrimitive.Content value="storybook" className="focus-visible:outline-none">
                  <StorybookTab taskId={task.id} projectId={task.projectId} status={storybook} onStatus={setStorybook} />
                </TabsPrimitive.Content>
              )}
              {previewable && section === 'preview' && project && (
                <TabsPrimitive.Content value="preview" className="h-[70vh] focus-visible:outline-none">
                  <PreviewPage project={project} task={task} />
                </TabsPrimitive.Content>
              )}
            </>
          )}
        </div>
      </div>
    </TabsPrimitive.Root>
  );
}
