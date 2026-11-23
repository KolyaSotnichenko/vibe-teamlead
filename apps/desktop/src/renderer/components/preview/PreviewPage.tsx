/**
 * Sidebar → Preview: the project's app from main, inside the window. It starts
 * when this page opens and stops when it goes away. What it runs comes from the
 * project's recipe, its saved services or its files; the owner is asked only when
 * none of them says which service is the page.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewNote, PreviewService, PreviewStatus, Project, Task } from '../../../shared/types';
import { updateProjectSettings } from '../../stores/project-store';
import { EmptyState, Notice } from '../task-detail/workspace/workspace-ui';
import { PreviewServicesForm } from './PreviewServicesForm';
import { PreviewToolbar, type PreviewSide, type PreviewWidth } from './PreviewToolbar';
import { UxReviewPanel } from './UxReviewPanel';
import { AddressNotice } from './AddressNotice';
import { NotesPanel } from './NotesPanel';
import { LogsPanel } from './LogsPanel';
import { EnvPanel } from './EnvPanel';
import { MailPanel } from './MailPanel';
import { RunningDoc, useRunningDoc } from './RunningDoc';
import { notesImages, notesTask } from './notes-task';
import { createTask, startTaskOrQueue, submitReview } from '../../stores/task-store';
import { usePreviewSession } from './usePreviewSession';

/** Notes as one task, in the queue: it starts when a slot is free */
async function sendNotes(projectId: string, notes: PreviewNote[], title: string, quickFix: boolean): Promise<boolean> {
  const task = notesTask(notes, title);
  const created = await createTask(projectId, task.title, task.description, { sourceType: 'manual', previewQuickFix: quickFix, attachedImages: notesImages(notes) });
  if (!created) return false;
  await startTaskOrQueue(created.id);
  return true;
}

/** Notes on a task's own preview go back into that task as a fix round */
async function sendBack(task: Task, notes: PreviewNote[]): Promise<boolean> {
  const { description } = notesTask(notes, task.title);
  return submitReview(task.id, false, description, notesImages(notes));
}

/** `task`: that task's worktree, inside its window, instead of the project's main */
export function PreviewPage({ project, task }: { project: Project; task?: Task }) {
  const { t } = useTranslation(['tasks']);
  const saved = project.settings.previewServices ?? [];
  const [editing, setEditing] = useState(false);
  /** What the form shows: the services a start would run, or the proposal when nothing says */
  const [form, setForm] = useState<{ services: PreviewService[]; readOnly: boolean } | null>(null);
  const [width, setWidth] = useState<PreviewWidth>(null);
  const [side, setSide] = useState<PreviewSide>(null);
  const { status, boxRef } = usePreviewSession(project.id, !editing, task?.id);
  const needsServices = status?.stage === 'failed' && status.needsServices === true;
  // The preview could not tell what to run: the form opens, once for that answer
  const asked = useRef<PreviewStatus | null>(null);
  useEffect(() => {
    if (!needsServices || asked.current === status) return;
    asked.current = status;
    setEditing(true);
  }, [needsServices, status]);
  // How to run it by hand: read again when the preview fails or comes up, the moments it is shown
  const runningDoc = useRunningDoc(project.id, task?.id, status?.stage === 'failed' || status?.stage === 'ready' ? status.stage : null);

  const taskId = task?.id;
  useEffect(() => {
    if (!editing) {
      setForm(null);
      return;
    }
    let live = true;
    void (async () => {
      const api = window.electronAPI.preview;
      const recipe = await (taskId ? api.recipe(project.id, taskId) : api.recipe(project.id));
      const found = recipe.success && recipe.data ? recipe.data : null;
      if (found?.services.length) {
        if (live) setForm({ services: found.services, readOnly: found.servicesFrom === 'file' });
        return;
      }
      // Nothing says what to run: what the project's files propose, for the owner to choose from
      const proposed = await api.proposeServices(project.id);
      if (live) setForm({ services: proposed.success && proposed.data ? proposed.data : [], readOnly: false });
    })();
    return () => { live = false; };
  }, [editing, project.id, taskId]);

  if (editing) {
    return (
      <div className="h-full overflow-auto p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('preview.title')}</h2>
        {form === null ? (
          <p className="text-sm text-muted-foreground">{t('preview.services.looking')}</p>
        ) : (
          <PreviewServicesForm
            initial={form.services}
            readOnly={form.readOnly}
            // Asked because nothing says what to run: there is nothing to go back to
            onCancel={needsServices ? undefined : () => setEditing(false)}
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
        onReset={() => void (task ? window.electronAPI.preview.resetData(project.id, task.id) : window.electronAPI.preview.resetData(project.id))}
        onEditServices={() => setEditing(true)}
        side={side}
        onSide={setSide}
        uxReview={!task}
        // Always there: a blank or broken page is not an error the app can see
        howToRun={runningDoc !== null}
      />
      {status?.database === 'unavailable' && status.databaseReason && (
        <div className="px-4 pt-2"><Notice>{status.databaseReason}</Notice></div>
      )}
      {status?.recipe?.invalid && (
        <div className="px-4 pt-2"><Notice>{t('preview.recipeInvalid', { reason: status.recipe.invalid })}</Notice></div>
      )}
      {status?.servicesNotices?.map((notice) => (
        <div key={notice} className="px-4 pt-2"><Notice>{notice}</Notice></div>
      ))}
      {ready && status.addressIssues && status.addressIssues.length > 0 && (
        <div className="px-4 pt-2">
          <AddressNotice projectId={project.id} issues={status.addressIssues} services={saved} />
          {side !== 'running' && (
            <div className="mt-2 max-h-64 overflow-auto border border-border bg-background p-3">
              <RunningDoc projectId={project.id} doc={runningDoc} />
            </div>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 justify-center bg-muted">
        <div ref={boxRef} className="relative h-full" style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}>
          {!ready && (
            <div className="absolute inset-0 overflow-auto bg-background p-6">
              {status?.stage === 'failed' ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm font-semibold text-destructive">
                    {status.stoppedService
                      ? t('preview.serviceStopped', { service: status.stoppedService })
                      : status.recipe && status.recipe.kind !== 'web'
                        ? t(`preview.kind.${status.recipe.kind}`)
                        : (status.message ?? t('preview.failed'))}
                  </p>
                  {status.logTail && <pre className="max-h-96 overflow-auto border border-border p-3 font-mono text-xs">{status.logTail}</pre>}
                  <RunningDoc projectId={project.id} doc={runningDoc} />
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
          <NotesPanel
            projectId={project.id}
            taskId={task?.id}
            ready={ready}
            onSend={(notes, title, quick) => (task ? sendBack(task, notes) : sendNotes(project.id, notes, title, quick))}
          />
        </aside>
      )}
      {side === 'logs' && (
        <aside aria-label={t('preview.toolbar.logs')} className="w-96 shrink-0 border-l border-border bg-background">
          <LogsPanel projectId={project.id} />
        </aside>
      )}
      {side === 'env' && (
        <aside aria-label={t('preview.toolbar.env')} className="w-96 shrink-0 border-l border-border bg-background">
          <EnvPanel projectId={project.id} taskId={task?.id} settings={project.settings} stage={status?.stage} />
        </aside>
      )}
      {side === 'mail' && (
        <aside aria-label={t('preview.toolbar.mail')} className="w-96 shrink-0 border-l border-border bg-background">
          <MailPanel projectId={project.id} mail={status?.mail} reason={status?.mailReason} />
        </aside>
      )}
      {side === 'running' && runningDoc && (
        <aside aria-label={t('preview.toolbar.running')} className="w-96 shrink-0 overflow-auto border-l border-border bg-background p-4">
          <RunningDoc projectId={project.id} doc={runningDoc} />
        </aside>
      )}
      {side === 'ux' && !task && (
        <aside aria-label={t('preview.toolbar.ux')} className="w-96 shrink-0 border-l border-border bg-background">
          <UxReviewPanel projectId={project.id} ready={ready} />
        </aside>
      )}
      </div>
    </div>
  );
}
