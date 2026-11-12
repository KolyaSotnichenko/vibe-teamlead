/**
 * What the task's CI status says about itself in the task window: where to set CI up, why there
 * is no status (public repository), why the last push failed, that CI is running, or that it
 * failed (with the failed run).
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import type { DeployTarget } from '../../../shared/types/deploy';
import { useCiState } from './useCiState';

const PUSH_ERRORS = ['conflict', 'permissions', 'no-connection', 'unavailable'];
const LINK = 'text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2';

export function CiNotice({ task, onGoToDeploy }: { task: Task; onGoToDeploy?: (target: DeployTarget) => void }) {
  const { t } = useTranslation('tasks');
  const ci = useCiState(task);
  const headingId = useId();
  if (!ci) return null;

  const pushError = 'pushError' in ci ? ci.pushError : undefined;
  const lines: React.ReactNode[] = [];
  let title: string | undefined;

  if (ci.state === 'not-set-up') {
    title = t('taskCi.notSetUp');
    if (onGoToDeploy) {
      lines.push(
        <button key="setup" type="button" onClick={() => onGoToDeploy({ tab: 'environment' })} className={LINK}>
          {t('taskCi.setUp')}
        </button>
      );
    }
  } else if (ci.state === 'unavailable' && ci.reason === 'public-repo') {
    title = t('taskCi.publicRepo');
  } else if (ci.state === 'running') {
    title = t('taskCi.runningTitle');
  } else if (ci.state === 'failed') {
    title = t('taskCi.failedTitle');
    const target: DeployTarget = { tab: 'runs', runId: ci.runId };
    if (ci.jobId !== undefined) target.jobId = ci.jobId;
    lines.push(
      <button
        key="failed"
        type="button"
        onClick={() => {
          if (onGoToDeploy) onGoToDeploy(target);
          else window.dispatchEvent(new CustomEvent<DeployTarget>('open-deploy', { detail: target }));
        }}
        className={LINK}
      >
        {t('taskCi.openRun')}
      </button>
    );
  }

  if (pushError) {
    const reason = t(`taskCi.pushError.${PUSH_ERRORS.includes(pushError) ? pushError : 'unavailable'}`);
    lines.push(
      <p key="push" className="mt-0.5 text-sm text-muted-foreground">
        {t('taskCi.pushFailed', { reason })}
      </p>
    );
  }

  if (!title && !lines.length) return null;
  const failedPush = !!pushError || ci.state === 'failed';

  return (
    <section aria-labelledby={headingId} className={`border-l-2 py-1 pl-4 ${failedPush ? 'border-l-[var(--vt-signal)]' : 'border-l-border'}`}>
      <h3 id={headingId} className="text-sm font-semibold text-foreground">{title ?? t('taskCi.title')}</h3>
      {lines}
    </section>
  );
}
