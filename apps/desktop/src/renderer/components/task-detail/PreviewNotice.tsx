/**
 * What the task's preview says about itself in the task window: where to set deploy up,
 * why there is no preview, why the last push failed, that it is building (with the previous
 * link), that it failed (with the build log or the failed run), or the link itself.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import type { DeployTarget } from '../../../shared/types/deploy';
import { formatRelative, openWebUrl, isHttpsUrl } from '../deploy/status';
import { usePreview } from './usePreview';

const PUSH_ERRORS = ['conflict', 'permissions', 'no-connection', 'unavailable'];

export function PreviewNotice({ task, onGoToDeploy }: { task: Task; onGoToDeploy?: (target: DeployTarget) => void }) {
  const { t, i18n } = useTranslation('tasks');
  const preview = usePreview(task);
  const headingId = useId();
  if (!preview) return null;

  const pushError = 'pushError' in preview ? preview.pushError : undefined;
  const lines: React.ReactNode[] = [];
  let title: string | undefined;

  if (preview.state === 'not-set-up') {
    title = t('taskPreview.notSetUp');
    if (onGoToDeploy) {
      lines.push(
        <button
          key="setup"
          type="button"
          onClick={() => onGoToDeploy({ tab: 'environment' })}
          className="text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2"
        >
          {t('taskPreview.setUp')}
        </button>
      );
    }
  } else if (preview.state === 'unavailable' && preview.reason === 'public-repo') {
    title = t('taskPreview.publicRepo');
  } else if (preview.state === 'building') {
    title = t('taskPreview.building');
    const previous = preview.previousUrl;
    if (isHttpsUrl(previous)) {
      lines.push(
        <p key="previous" className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-xs text-muted-foreground">{t('taskPreview.previous')}</span>
          <button
            type="button"
            onClick={() => openWebUrl(previous)}
            className="break-all font-mono text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2"
          >
            {previous}
          </button>
        </p>
      );
    }
  } else if (preview.state === 'failed') {
    title = t('taskPreview.previewFailed');
    const logUrl = preview.logUrl;
    // Same as the card: the failed Actions run when there is one, else Vercel's build log
    const action =
      preview.runId === undefined && isHttpsUrl(logUrl)
        ? { label: t('taskPreview.openLog'), run: () => openWebUrl(logUrl) }
        : {
            label: t(preview.runId === undefined ? 'taskPreview.openDeploy' : 'taskPreview.openRun'),
            run: () => {
              const target: DeployTarget = { tab: 'runs' };
              if (preview.runId !== undefined) target.runId = preview.runId;
              if (preview.jobId !== undefined) target.jobId = preview.jobId;
              if (onGoToDeploy) onGoToDeploy(target);
              else window.dispatchEvent(new CustomEvent<DeployTarget>('open-deploy', { detail: target }));
            },
          };
    lines.push(
      <button
        key="failed"
        type="button"
        onClick={action.run}
        className="text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2"
      >
        {action.label}
      </button>
    );
  } else if (preview.state === 'ready' && isHttpsUrl(preview.url)) {
    title = t('taskPreview.title');
    lines.push(
      <p key="link" className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
        <button
          type="button"
          onClick={() => openWebUrl(preview.url)}
          className="break-all font-mono text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2"
        >
          {preview.url}
        </button>
        <span className="text-xs text-muted-foreground">{t('taskPreview.built', { when: formatRelative(preview.builtAt, i18n.language) })}</span>
      </p>
    );
  }

  if (pushError) {
    const reason = t(`taskPreview.pushError.${PUSH_ERRORS.includes(pushError) ? pushError : 'unavailable'}`);
    lines.push(
      <p key="push" className="mt-0.5 text-sm text-muted-foreground">
        {t('taskPreview.pushFailed', { reason })}
      </p>
    );
  }

  if (!title && !lines.length) return null;
  const failedPush = !!pushError || preview.state === 'failed';

  return (
    <section aria-labelledby={headingId} className={`border-l-2 py-1 pl-4 ${failedPush ? 'border-l-[var(--vt-signal)]' : 'border-l-border'}`}>
      <h3 id={headingId} className="text-sm font-semibold text-foreground">{title ?? t('taskPreview.title')}</h3>
      {lines}
    </section>
  );
}
