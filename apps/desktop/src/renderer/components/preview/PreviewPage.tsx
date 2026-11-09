/**
 * Sidebar → Preview: the project's app from main, inside the window. It starts
 * when this page opens and stops when it goes away. The first time, the owner
 * confirms which services it runs.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewNote, PreviewService, Project } from '../../../shared/types';
import { updateProjectSettings } from '../../stores/project-store';
import { EmptyState, Notice } from '../task-detail/workspace/workspace-ui';
import { PreviewServicesForm } from './PreviewServicesForm';
import { PreviewToolbar, type PreviewSide, type PreviewWidth } from './PreviewToolbar';
import { UxReviewPanel } from './UxReviewPanel';
import { NotesPanel } from './NotesPanel';
import { notesImages, notesTask } from './notes-task';
import { createTask, startTaskOrQueue } from '../../stores/task-store';
import { usePreviewSession } from './usePreviewSession';

/** Notes as one task, in the queue: it starts when a slot is free */
async function sendNotes(projectId: string, notes: PreviewNote[], title: string, quickFix: boolean): Promise<boolean> {
  const task = notesTask(notes, title);
  const created = await createTask(projectId, task.title, task.description, { sourceType: 'manual', previewQuickFix: quickFix, attachedImages: notesImages(notes) });
  if (!created) return false;
  await startTaskOrQueue(created.id);
  return true;
}

export function PreviewPage({ project }: { project: Project }) {
  const { t } = useTranslation(['tasks']);
  const saved = project.settings.previewServices ?? [];
  const [editing, setEditing] = useState(saved.length === 0);
  const [proposed, setProposed] = useState<PreviewService[] | null>(null);
  const [width, setWidth] = useState<PreviewWidth>(null);
  const [side, setSide] = useState<PreviewSide>(null);
  const { status, boxRef } = usePreviewSession(project.id, !editing && saved.length > 0);

  useEffect(() => {
    if (!editing || saved.length) return;
    let live = true;
    void window.electronAPI.preview.proposeServices(project.id).then((result) => {
      if (live) setProposed(result.success && result.data ? result.data : []);
    });
    return () => { live = false; };
  }, [editing, saved.length, project.id]);

  if (editing) {
    const initial = saved.length ? saved : proposed;
    return (
      <div className="h-full overflow-auto p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('preview.title')}</h2>
        {initial === null ? (
          <p className="text-sm text-muted-foreground">{t('preview.services.looking')}</p>
        ) : (
          <PreviewServicesForm
            initial={initial}
            onCancel={saved.length ? () => setEditing(false) : undefined}
            onSave={async (services) => {
              if (await updateProjectSettings(project.id, { previewServices: services })) setEditing(false);
            }}
          />
        )}
      </div>
    );
  }

  const ready = status?.stage === 'ready';
  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar
        url={status?.url}
        width={width}
        onWidth={setWidth}
        disabled={!ready}
        onNavigate={(navigation) => void window.electronAPI.preview.navigate(navigation)}
        onReset={() => void window.electronAPI.preview.resetData(project.id)}
        onEditServices={() => setEditing(true)}
        side={side}
        onSide={setSide}
      />
      {status?.database === 'unavailable' && status.databaseReason && (
        <div className="px-4 pt-2"><Notice>{status.databaseReason}</Notice></div>
      )}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 justify-center bg-muted">
        <div ref={boxRef} className="relative h-full" style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}>
          {!ready && (
            <div className="absolute inset-0 overflow-auto bg-background p-6">
              {status?.stage === 'failed' ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm font-semibold text-destructive">{status.message ?? t('preview.failed')}</p>
                  {status.logTail && <pre className="max-h-96 overflow-auto border border-border p-3 font-mono text-xs">{status.logTail}</pre>}
                </div>
              ) : (
                <EmptyState title={t(`preview.stage.${status?.stage ?? 'worktree'}`)} body={status?.message ?? t('preview.startingBody')} />
              )}
            </div>
          )}
        </div>
      </div>
      {side === 'notes' && (
        <aside aria-label={t('preview.toolbar.notes')} className="w-96 shrink-0 border-l border-border bg-background">
          <NotesPanel projectId={project.id} ready={ready} onSend={(notes, title, quick) => sendNotes(project.id, notes, title, quick)} />
        </aside>
      )}
      {side === 'ux' && (
        <aside aria-label={t('preview.toolbar.ux')} className="w-96 shrink-0 border-l border-border bg-background">
          <UxReviewPanel projectId={project.id} ready={ready} />
        </aside>
      )}
      </div>
    </div>
  );
}
