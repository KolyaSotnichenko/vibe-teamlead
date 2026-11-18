/**
 * How to run the project by hand, for when the preview can't: its RUNNING.md, with a
 * button that opens a terminal in its folder (the owner runs the commands; nothing is
 * typed for them). Without the file, a button that makes writing it a task.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewRunningDoc } from '../../../shared/types';
import { openTerminal } from '../../lib/open-terminal';
import { createTask } from '../../stores/task-store';
import { Button } from '../ui/button';
import { WorkspaceMarkdown } from '../task-detail/workspace/workspace-ui';
import { runningTask } from './running-task';

/** The project's (or the task's) RUNNING.md; read again whenever `again` changes. Null until read. */
export function useRunningDoc(projectId: string, taskId: string | undefined, again: unknown): PreviewRunningDoc | null {
  const [doc, setDoc] = useState<PreviewRunningDoc | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is only the signal to read the file again
  useEffect(() => {
    let live = true;
    const api = window.electronAPI.preview;
    void (taskId ? api.runningDoc(projectId, taskId) : api.runningDoc(projectId)).then((result) => {
      if (live && result?.success && result.data) setDoc(result.data);
    });
    return () => { live = false; };
  }, [projectId, taskId, again]);
  return doc;
}

export function RunningDoc({ projectId, doc }: { projectId: string; doc: PreviewRunningDoc | null }) {
  const { t } = useTranslation(['tasks']);
  const [created, setCreated] = useState(false);
  if (!doc) return null;

  if (!doc.exists) {
    const make = async () => {
      const { title, description } = runningTask();
      if (await createTask(projectId, title, description)) setCreated(true);
    };
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{t('preview.running.missing')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {created ? (
            <p className="text-foreground">{t('preview.running.taskCreated')}</p>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void make()}>{t('preview.running.createTask')}</Button>
          )}
          <Button size="sm" variant="outline" onClick={() => openTerminal(doc.dir)}>{t('preview.running.openTerminal')}</Button>
        </div>
      </div>
    );
  }

  return (
    <section aria-label={t('preview.running.title')} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-foreground pb-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">{t('preview.running.title')}</h3>
        <Button size="sm" variant="outline" onClick={() => openTerminal(doc.dir)}>{t('preview.running.openTerminal')}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('preview.running.intro')}</p>
      <WorkspaceMarkdown markdown={doc.markdown} />
      {doc.truncated && <p className="text-xs text-muted-foreground">{t('preview.running.truncated')}</p>}
    </section>
  );
}
