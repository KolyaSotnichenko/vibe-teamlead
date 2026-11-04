/**
 * Workspace → Storybook: the task's components, live, before merging. Runs the
 * Storybook of the task's worktree (installing its dependencies the first time).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, Play, Square } from 'lucide-react';
import type { TaskStorybookStatus } from '../../../../shared/types';
import { Button } from '../../ui/button';
import { EmptyState, Notice, SectionHeader } from './workspace-ui';

export function StorybookTab({ taskId, projectId, status, onStatus }: {
  taskId: string;
  projectId: string;
  status: TaskStorybookStatus;
  onStatus: (status: TaskStorybookStatus) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = status.running?.url ?? null;

  useEffect(
    () => window.electronAPI.design.onProgress((e) => e.projectId === `task:${taskId}` && setProgress(e.message)),
    [taskId],
  );

  const refresh = async () => {
    const result = await window.electronAPI.design.taskStorybookStatus(taskId, projectId);
    if (result.success && result.data) onStatus(result.data);
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    setProgress(null);
    try {
      const result = await window.electronAPI.design.startTaskStorybook(taskId, projectId);
      if (!result.success) setError(result.error ?? t('tasks:workspace.storybook.failed'));
    } finally {
      setStarting(false);
      setProgress(null);
      await refresh();
    }
  };

  const stop = async () => {
    await window.electronAPI.design.stopTaskStorybook(taskId, projectId);
    await refresh();
  };

  return (
    <section className="space-y-4" aria-labelledby="ws-storybook">
      <SectionHeader
        id="ws-storybook"
        title="Storybook"
        meta={`${status.dir}${status.script ? ` · ${status.packageManager ?? 'npm'} run ${status.script}` : ''}`}
        action={
          url ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void window.electronAPI.openExternal(url)}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {t('tasks:workspace.storybook.openBrowser')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void stop()}>
                <Square className="mr-1.5 h-3.5 w-3.5" />
                {t('tasks:workspace.storybook.stop')}
              </Button>
            </div>
          ) : (
            <Button size="sm" disabled={starting || status.installing} onClick={() => void start()}>
              {starting || status.installing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
              {status.needsInstall ? t('tasks:workspace.storybook.installAndStart') : t('tasks:workspace.storybook.start')}
            </Button>
          )
        }
      />
      <p className="max-w-prose text-sm text-muted-foreground">{t('tasks:workspace.storybook.intro')}</p>
      {status.needsInstall && !url && <Notice>{t('tasks:workspace.storybook.installNote')}</Notice>}
      {(starting || status.installing) && (
        <div role="status" aria-busy="true" className="flex items-center gap-2 border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
          <span className="h-2 w-2 shrink-0 animate-pulse bg-foreground" aria-hidden="true" />
          <span className="truncate font-mono text-xs">{progress ?? t('tasks:workspace.storybook.starting')}</span>
        </div>
      )}
      {error && (
        <pre role="alert" className="max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-destructive bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {error}
        </pre>
      )}
      {url ? (
        <iframe title={`Storybook — ${taskId}`} src={url} className="h-[70vh] min-h-[480px] w-full border border-foreground bg-white" />
      ) : (
        !starting && !status.installing && !error && <EmptyState compact title={t('tasks:workspace.storybook.notRunningTitle')} body={t('tasks:workspace.storybook.notRunningBody')} />
      )}
    </section>
  );
}
