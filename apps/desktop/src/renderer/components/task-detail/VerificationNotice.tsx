/**
 * What the app's own checks found. A pass is one quiet block; a run that couldn't say
 * everything says why, since silence would read as a pass. What a task broke is listed
 * by the panel that says what to fix.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import type { Task } from '../../../shared/types';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';
import { useVerification } from './useVerification';
import { STARTS_CHECK_COMMAND } from '../../../shared/utils/verification-summary';

type Check = VerificationSummary['checks'][number];

function outcomeKey(check: Check): string {
  if (check.outcome === 'passed') return 'verification.outcome.passed';
  // The start-up check that could not run here (a port in use, Docker): not a missing tool
  if (check.outcome === 'unavailable') return check.command === STARTS_CHECK_COMMAND ? 'verification.outcome.notTried' : 'verification.outcome.noTool';
  if (check.outcome === 'timed_out') return 'verification.outcome.timedOut';
  return check.onBase && check.onBase !== 'passed' ? 'verification.outcome.sameOnBase' : 'verification.outcome.failed';
}

export function VerificationNotice({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const loaded = useVerification(task);
  /** What a run the owner asked for here found: it replaces what was loaded */
  const [again, setAgain] = useState<{ taskId: string; summary: VerificationSummary } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const summary = again?.taskId === task.id ? again.summary : loaded;
  // A regression found at QA is listed by the panel that says what to fix; one found by a run asked for here, by nothing else
  if (!summary || (summary.status === 'regression' && again?.taskId !== task.id)) return null;

  const checkAgain = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.verifyTaskAgain(task.id, task.projectId);
      if (result.success && result.data) setAgain({ taskId: task.id, summary: result.data });
      else setError(result.error ?? '');
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };

  const passed = summary.status === 'passed';
  const title = passed
    ? 'verification.passedTitle'
    : summary.status === 'regression'
      ? 'verification.regressionTitle'
      : summary.status === 'not_configured'
        ? 'verification.notConfiguredTitle'
        : 'verification.notVerifiedTitle';

  return (
    <section aria-labelledby="verification" className={`border-l-2 py-1 pl-4 ${passed ? 'border-l-border' : 'border-l-[var(--vt-signal)]'}`}>
      <h3 id="verification" className="text-sm font-semibold text-foreground">{t(title)}</h3>
      {summary.status === 'not_configured' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.notConfiguredBody')}</p>}
      {summary.source === 'task' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.fromTask')}</p>}
      {summary.services?.status === 'unavailable' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.dockerNeeded')}</p>}
      {summary.services?.status === 'started' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.temporaryDatabase')}</p>}
      {summary.migrationsSkipped && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.migrationsSkipped')}</p>}
      {summary.checks.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {summary.checks.map((check) => (
            <li key={check.command} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              {check.command === STARTS_CHECK_COMMAND ? (
                <span className="text-foreground">{t('verification.startsCheck')}</span>
              ) : (
                <span className="break-all font-mono text-foreground">{check.command}</span>
              )}
              <span className="text-muted-foreground">
                {check.why ? t(`verification.startsWhy.${check.why.reason === 'port' && !check.why.ports?.length ? 'portUnnamed' : check.why.reason}`, { names: (check.why.names ?? []).join(', '), ports: (check.why.ports ?? []).join(', ') }) : t(outcomeKey(check))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-1 text-sm text-destructive">{error}</p>}
      {!passed && summary.status !== 'not_configured' && (
        <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => void checkAgain()}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t(busy ? 'verification.againRunning' : 'verification.again')}
        </Button>
      )}
    </section>
  );
}
