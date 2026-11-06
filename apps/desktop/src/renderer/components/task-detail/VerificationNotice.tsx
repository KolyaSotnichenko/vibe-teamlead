/**
 * What the app's own checks found. A pass is one quiet block; a run that couldn't say
 * everything says why, since silence would read as a pass. What a task broke is listed
 * by the panel that says what to fix.
 */

import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';
import { useVerification } from './useVerification';

type Check = VerificationSummary['checks'][number];

function outcomeKey(check: Check): string {
  if (check.outcome === 'passed') return 'verification.outcome.passed';
  if (check.outcome === 'unavailable') return 'verification.outcome.noTool';
  if (check.outcome === 'timed_out') return 'verification.outcome.timedOut';
  return check.onBase && check.onBase !== 'passed' ? 'verification.outcome.sameOnBase' : 'verification.outcome.failed';
}

export function VerificationNotice({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const summary = useVerification(task);
  if (!summary || summary.status === 'regression') return null;

  const passed = summary.status === 'passed';
  const title = passed ? 'verification.passedTitle' : summary.status === 'not_configured' ? 'verification.notConfiguredTitle' : 'verification.notVerifiedTitle';

  return (
    <section aria-labelledby="verification" className={`border-l-2 py-1 pl-4 ${passed ? 'border-l-border' : 'border-l-[var(--vt-signal)]'}`}>
      <h3 id="verification" className="text-sm font-semibold text-foreground">{t(title)}</h3>
      {summary.status === 'not_configured' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.notConfiguredBody')}</p>}
      {summary.services?.status === 'unavailable' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.dockerNeeded')}</p>}
      {summary.services?.status === 'started' && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.temporaryDatabase')}</p>}
      {summary.migrationsSkipped && <p className="mt-0.5 text-sm text-muted-foreground">{t('verification.migrationsSkipped')}</p>}
      {summary.checks.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {summary.checks.map((check) => (
            <li key={check.command} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="break-all font-mono text-foreground">{check.command}</span>
              <span className="text-muted-foreground">{t(outcomeKey(check))}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
