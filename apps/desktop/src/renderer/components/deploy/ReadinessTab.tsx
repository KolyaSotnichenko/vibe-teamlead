/**
 * Deploy → Readiness: what stands between the project and a first deploy. Blockers with their
 * tasks, what only the owner can do, and the state of CI. The scan itself runs in main; this
 * tab shows its last result and asks for a new one.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeployVariableInput, ReadinessBlocker, ReadinessState } from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { Notice, Row, Section } from './parts';
import { VariableDialog } from './VariableDialog';
import { formatRelative, StatusMark } from './status';

const TASK_STATUSES: ReadonlySet<string> = new Set(['backlog', 'queue', 'in_progress', 'ai_review', 'human_review', 'done', 'pr_created', 'error']);

export interface ReadinessTabProps {
  projectId: string;
  /** Undefined until the first read. */
  readiness?: ReadinessState;
  /** Deploy is not set up yet: offer Set up deploy when nothing blocks. */
  notSetUp: boolean;
  onSetUp: () => void;
  onOpenRuns: () => void;
  /** Opens a task by its spec id. */
  onGoToTask?: (specId: string) => void;
}

export function ReadinessTab({ projectId, readiness, notSetUp, onSetUp, onOpenRuns, onGoToTask }: ReadinessTabProps) {
  const { t, i18n } = useTranslation(['deploy']);
  const [dialog, setDialog] = useState<{ name: string } | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  if (!readiness) return <p className="text-sm text-muted-foreground">{t('deploy:readiness.loading')}</p>;
  const { result, scanning, error, tasks } = readiness;

  const saveVariable = async (input: DeployVariableInput) => {
    const r = await window.electronAPI.deploy.setVariable(projectId, input);
    return r.success && r.data ? r.data : null;
  };

  const blocker = (b: ReadinessBlocker) => {
    const task = tasks[b.key];
    const done = task?.status === 'done';
    return (
      <li key={b.key} className="flex flex-col gap-1 border-b border-border px-3 py-3 last:border-b-0">
        <div className="flex items-baseline gap-2">
          <StatusMark status={done ? 'success' : 'attention'} />
          {b.kind !== 'unsupported' && task ? (
            <button
              type="button"
              onClick={() => onGoToTask?.(task.specId)}
              className="text-left text-sm font-semibold text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {b.title}
            </button>
          ) : (
            <span className="text-sm font-semibold text-foreground">{b.title}</span>
          )}
        </div>
        <p className="pl-6 text-sm text-muted-foreground">{b.detail}</p>
        {b.kind === 'unsupported' ? (
          <p className="pl-6 text-sm text-foreground">{t('deploy:readiness.unsupported')}</p>
        ) : (
          task && (
            <p className="pl-6 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
              {TASK_STATUSES.has(task.status ?? '') ? t(`deploy:readiness.taskStatus.${task.status}`) : t('deploy:readiness.taskStatus.pending')}
            </p>
          )
        )}
      </li>
    );
  };

  const blockers = result?.blockers ?? [];
  const owner = result?.owner ?? [];
  const run = result?.workflow.lastMainRun;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          {result && (
            <span className="text-sm text-muted-foreground">
              {t('deploy:readiness.checked', { ago: formatRelative(result.scannedAt, i18n.language) })}
            </span>
          )}
          {scanning && (
            <span role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden="true" className="vt-breathe inline-block h-2 w-2 bg-foreground" />
              {t('deploy:readiness.scanning')}
            </span>
          )}
        </div>
        <Button variant="outline" disabled={scanning} onClick={() => void window.electronAPI.deploy.scanReadiness(projectId, 'check-again')}>
          {t('deploy:readiness.checkAgain')}
        </Button>
      </div>

      {error && <Notice tone="attention">{t('deploy:readiness.error')}</Notice>}
      {savedNote && <Notice tone="info">{savedNote}</Notice>}

      {result && blockers.length === 0 && (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="info">{t('deploy:readiness.clear')}</Notice>
          {notSetUp && <Button onClick={onSetUp}>{t('deploy:setup.start')}</Button>}
        </div>
      )}

      {blockers.length > 0 && (
        <Section id="deploy-readiness-blockers" title={t('deploy:readiness.blockers')}>
          <ul className="flex flex-col border border-foreground">{blockers.map(blocker)}</ul>
        </Section>
      )}

      {owner.length > 0 && (
        <Section id="deploy-readiness-owner" title={t('deploy:readiness.owner')}>
          <ul className="flex flex-col border border-foreground">
            {owner.map((item, i) => (
              <li key={`${item.variable ?? 'other'}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3 last:border-b-0">
                <span className="min-w-0 flex-1 text-sm text-foreground">
                  {item.kind === 'variable' && item.variable ? <span className="font-mono">{item.variable}</span> : item.message}
                </span>
                {item.kind === 'variable' && item.variable && (
                  <Button size="sm" variant="outline" onClick={() => setDialog({ name: item.variable as string })}>
                    {t('deploy:readiness.addValue')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {result && (
        <Section id="deploy-readiness-ci" title={t('deploy:readiness.ci')}>
          <dl className="border border-border">
            <Row label={t('deploy:readiness.workflow')}>
              <span className="font-mono">{result.workflow.path ?? t('deploy:readiness.noWorkflow')}</span>
            </Row>
            <Row label={t('deploy:readiness.lastRun')}>
              {run ? (
                <>
                  <span>{t('deploy:readiness.conclusion', { conclusion: run.conclusion })}</span>
                  <button
                    type="button"
                    onClick={onOpenRuns}
                    className="text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('deploy:readiness.openRuns')}
                  </button>
                </>
              ) : (
                <span className="text-muted-foreground">{t('deploy:readiness.noRun')}</span>
              )}
            </Row>
          </dl>
        </Section>
      )}

      <VariableDialog
        open={dialog !== null}
        initialName={dialog?.name}
        onClose={() => setDialog(null)}
        onSave={saveVariable}
        onSaved={(name) => {
          setDialog(null);
          setSavedNote(t('deploy:variables.saved', { name }));
        }}
      />
    </div>
  );
}
