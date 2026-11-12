/**
 * CI → Readiness: what keeps the project's GitHub Actions CI from passing. Blockers with their
 * tasks, what only the owner can do (CI secrets GitHub lacks, saved here as GitHub Actions
 * secrets), and the state of CI. The check itself runs in main; this tab shows its last result
 * and asks for a new one.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReadinessBlocker, ReadinessOwnerItem, ReadinessState } from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { Notice, Row, Section } from './parts';
import { SecretDialog } from './SecretDialog';
import { formatRelative, isCiBlocker, isWebUrl, openWebUrl, StatusMark } from './status';

const CONCLUSIONS: Record<string, 'success' | 'attention' | 'skipped'> = {
  success: 'success',
  failure: 'attention',
  timed_out: 'attention',
  startup_failure: 'attention',
  cancelled: 'skipped',
  skipped: 'skipped',
  neutral: 'skipped',
  action_required: 'skipped',
  stale: 'skipped',
};

const TASK_STATUSES: ReadonlySet<string> = new Set(['backlog', 'queue', 'in_progress', 'ai_review', 'human_review', 'done', 'pr_created', 'error']);

/** The secret an owner item names (an old result says `variable` for it), or undefined. */
const secretOf = (item: ReadinessOwnerItem): string | undefined =>
  (item.kind === 'secret' || (item.kind as string) === 'variable') && item.variable ? item.variable : undefined;

export interface ReadinessTabProps {
  projectId: string;
  /** Undefined until the first read. */
  readiness?: ReadinessState;
  /** Deploy is not set up yet: offer Set up deploy when nothing blocks. */
  notSetUp: boolean;
  /** CI is set up (the repository is recorded; known, not still loading): secrets can be added and are listed. */
  isSetUp?: boolean;
  onSetUp: () => void;
  onOpenRuns: () => void;
  /** Opens a task by its spec id. */
  onGoToTask?: (specId: string) => void;
}

export function ReadinessTab({ projectId, readiness, notSetUp, isSetUp = false, onSetUp, onOpenRuns, onGoToTask }: ReadinessTabProps) {
  const { t, i18n } = useTranslation(['deploy']);
  const [dialog, setDialog] = useState<{ name: string } | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** The repository's GitHub Actions secret names (set up only): a scan's secret items that have one are done */
  const [present, setPresent] = useState<ReadonlySet<string>>(new Set());

  const loadSecrets = useCallback(async () => {
    try {
      const r = await window.electronAPI.deploy.listSecrets(projectId);
      if (r.success && r.data?.ok) setPresent(new Set(r.data.names));
    } catch {
      // the check's list stands
    }
  }, [projectId]);

  useEffect(() => {
    if (isSetUp) void loadSecrets();
  }, [isSetUp, loadSecrets]);

  if (!readiness) return <p className="text-sm text-muted-foreground">{t('deploy:readiness.loading')}</p>;
  const { result, scanning, error, tasks } = readiness;

  const blocker = (b: ReadinessBlocker) => {
    const task = tasks[b.key];
    const done = task?.status === 'done';
    return (
      <li key={b.key} className="flex flex-col gap-1 border-b border-border px-3 py-3 last:border-b-0">
        <div className="flex items-baseline gap-2">
          <StatusMark status={done ? 'success' : 'attention'} />
          {task ? (
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
        {task && (
          <p className="pl-6 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {TASK_STATUSES.has(task.status ?? '') ? t(`deploy:readiness.taskStatus.${task.status}`) : t('deploy:readiness.taskStatus.pending')}
          </p>
        )}
      </li>
    );
  };

  const blockers = (result?.blockers ?? []).filter(isCiBlocker);
  // Before setup there is no repository to hold secrets; after it, the ones GitHub has are done
  const owner = (result?.owner ?? []).filter((item) => {
    const secret = secretOf(item);
    return !(isSetUp && secret && present.has(secret));
  });
  const secretsLeft = isSetUp ? owner.filter((item) => secretOf(item)).length : 0;
  const run = result?.workflow.lastMainRun;
  const conclusion = run && Object.hasOwn(CONCLUSIONS, run.conclusion) ? run.conclusion : undefined;
  const gaveUp = readiness.gaveUp ?? [];
  /** A given-up key by name: its blocker's title, or the workflow of a run key */
  const gaveUpLabel = (key: string) =>
    key.startsWith('run:') ? key.slice('run:'.length) : (blockers.find((b) => b.key === key)?.title ?? key);

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

      {secretsLeft > 0 && <Notice tone="attention">{t('deploy:readiness.secretsLeft', { count: secretsLeft })}</Notice>}
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

      {(owner.length > 0 || gaveUp.length > 0) && (
        <Section id="deploy-readiness-owner" title={t('deploy:readiness.owner')}>
          <ul className="flex flex-col border border-foreground">
            {gaveUp.map((key) => {
              const link = readiness.gaveUpLinks?.[key];
              return (
                <li key={`gave-up-${key}`} className="flex flex-col gap-1 border-b border-border px-3 py-3 last:border-b-0">
                  <div className="flex items-baseline gap-2">
                    <StatusMark status="attention" />
                    <span className={`text-sm font-semibold text-foreground${key.startsWith('run:') ? ' font-mono' : ''}`}>{gaveUpLabel(key)}</span>
                  </div>
                  <p className="pl-6 text-sm text-foreground">{t('deploy:readiness.gaveUp')}</p>
                  {isWebUrl(link) && (
                    <button
                      type="button"
                      onClick={() => openWebUrl(link)}
                      className="self-start pl-6 text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('deploy:readiness.openRun')}
                    </button>
                  )}
                </li>
              );
            })}
            {owner.map((item, i) => {
              const secret = secretOf(item);
              return (
                <li key={`${secret ?? 'other'}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3 last:border-b-0">
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    {secret ? <span className="font-mono">{secret}</span> : item.message}
                  </span>
                  {secret &&
                    (isSetUp ? (
                      <Button size="sm" variant="outline" onClick={() => setDialog({ name: secret })}>
                        {t('deploy:readiness.addSecret')}
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t('deploy:readiness.setUpCiFirst')}</span>
                    ))}
                </li>
              );
            })}
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
                  <span className="inline-flex items-center gap-2">
                    <StatusMark status={conclusion ? CONCLUSIONS[conclusion] : 'skipped'} />
                    <span>{t(`deploy:readiness.conclusions.${conclusion ?? 'unknown'}`)}</span>
                  </span>
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

      <SecretDialog
        open={dialog !== null}
        projectId={projectId}
        initialName={dialog?.name}
        onClose={() => setDialog(null)}
        onSaved={(name) => {
          setDialog(null);
          setSavedNote(t('deploy:readiness.secretSaved', { name }));
          setPresent((names) => new Set([...names, name]));
        }}
      />
    </div>
  );
}
