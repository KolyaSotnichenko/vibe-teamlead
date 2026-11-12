/**
 * Deploy → Environment: set up CI (the GitHub repository steps), what the owner must do, what
 * exists (the repository, production URL) and the last push of main after a merge.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DeployProjectSettings,
  DeploySetupStep,
  GraphNodeStatus,
  NeededFromYou as NeededItem,
} from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { NeededFromYou } from './NeededFromYou';
import { Notice, Row, Section } from './parts';
import type { DeployEnv } from './useDeployEnv';
import { displayUrl, formatRelative, isWebUrl, LinkButton, StatusMark, useDeployErrorText } from './status';

/** Push failures with their own text; any other kind uses the shared deploy error text. */
const PUSH_ERROR_KINDS: ReadonlySet<string> = new Set(['conflict', 'permissions', 'no-connection', 'unavailable']);

const STEPS: DeploySetupStep[] = ['repo', 'push', 'done'];

function stepStatus(
  step: DeploySetupStep,
  at: { current?: DeploySetupStep; running: boolean; failed: boolean; waiting: boolean; settings: DeployProjectSettings | null }
): GraphNodeStatus | 'attention' {
  if (step === 'push' && at.settings?.repo && !at.settings.repo.createdByApp) return 'skipped';
  if (at.current === 'done' || (!at.running && at.settings?.enabled)) return 'success';
  // Before 'repo' setup checks the accounts: shown as the first step
  const current = STEPS.indexOf(at.current ?? 'repo');
  const index = STEPS.indexOf(step);
  if (index < current) return 'success';
  if (index > current) return 'queued';
  if (at.running) return 'running';
  if (at.failed) return 'failure';
  // Stopped for something only the owner can do
  return at.waiting ? 'attention' : 'queued';
}

export interface EnvironmentTabProps {
  projectId: string;
  /** Opens the GitHub sign-in dialog the Deploy page owns. */
  onConnectGitHub: () => void;
  env: DeployEnv;
  productionUrl?: string | null;
}

export function EnvironmentTab({ env, productionUrl, onConnectGitHub }: EnvironmentTabProps) {
  const { t, i18n } = useTranslation(['deploy']);
  const errorText = useDeployErrorText();
  const pushErrorText = (kind: string | undefined): string =>
    kind && PUSH_ERROR_KINDS.has(kind) ? t(`deploy:push.errors.${kind}`) : errorText(kind);
  const { state } = env;
  const settings = state?.settings ?? null;
  const setupRunning = !!state?.setupRunning;
  const lastSetup = state?.lastSetup;

  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());

  if (!state) {
    return <p className="text-sm text-muted-foreground">{t('deploy:env.loading')}</p>;
  }

  const repoName = settings?.repo ? `${settings.repo.owner}/${settings.repo.repo}` : undefined;

  const open = (n: NeededItem) => !acknowledged.has(n.id);
  const needed: NeededItem[] = (lastSetup?.needed ?? []).filter(open);

  const setupDone = !!settings?.enabled;
  const setupFailed = !!lastSetup?.error;
  const setupWaiting = (lastSetup?.needed ?? []).some((n) => n.kind !== 'public-repo-warning' && open(n));
  const showSetup = !setupDone || setupRunning || (lastSetup && lastSetup.step !== 'done');
  const current = setupRunning ? (env.progress ?? undefined) : lastSetup?.step;

  const push = state.lastPush;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {env.requestFailed && <Notice tone="attention">{t('deploy:env.errors.request')}</Notice>}

      {push && (
        <Notice tone={push.ok ? 'info' : 'attention'}>
          {push.ok
            ? t('deploy:push.ok', { ago: formatRelative(push.at, i18n.language) })
            : t('deploy:push.failed', { reason: pushErrorText(push.error?.kind), ago: formatRelative(push.at, i18n.language) })}
        </Notice>
      )}

      {showSetup && (
        <Section id="deploy-setup-title" title={t('deploy:setup.title')}>
          <p className="text-sm text-muted-foreground">{t('deploy:setup.description')}</p>
          <div>
            <Button disabled={setupRunning} onClick={() => void env.setUp()}>
              {setupRunning ? t('deploy:setup.running') : lastSetup ? t('deploy:setup.retry') : t('deploy:setup.start')}
            </Button>
          </div>
          {(setupRunning || lastSetup) && (
            <ol aria-label={t('deploy:setup.steps')} className="flex flex-col border border-foreground">
              {STEPS.map((step) => (
                <li key={step} className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
                  <StatusMark status={stepStatus(step, { current, running: setupRunning, failed: setupFailed, waiting: setupWaiting, settings })} />
                  <span>{t(`deploy:setup.step.${step}`)}</span>
                </li>
              ))}
            </ol>
          )}
          {lastSetup?.error && !setupRunning && <Notice tone="attention">{errorText(lastSetup.error.kind)}</Notice>}
        </Section>
      )}

      <NeededFromYou
        items={needed}
        repo={repoName}
        onAcknowledge={(id) => setAcknowledged((s) => new Set([...s, id]))}
        onConnectGitHub={onConnectGitHub}
      />

      {settings?.repo && (
        <Section id="deploy-exists-title" title={t('deploy:exists.title')}>
          <dl className="border border-foreground">
            {settings.repo && repoName && (
              <Row label={t('deploy:exists.repo')}>
                <LinkButton url={`https://github.com/${repoName}`} mono>
                  {repoName}
                </LinkButton>
                <span className="text-xs text-muted-foreground">
                  {settings.repo.public ? t('deploy:exists.public') : t('deploy:exists.private')}
                </span>
              </Row>
            )}
            {isWebUrl(productionUrl) && (
              <Row label={t('deploy:exists.production')}>
                <LinkButton url={productionUrl} mono>
                  {displayUrl(productionUrl)}
                </LinkButton>
              </Row>
            )}
          </dl>
        </Section>
      )}
    </div>
  );
}
