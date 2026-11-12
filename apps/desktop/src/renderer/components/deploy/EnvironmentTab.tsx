/**
 * Deploy → Environment: set up deploy (Vercel account or team, then the steps), what the owner
 * must do, what exists (repository, Vercel project, production URL, database), the variables,
 * and the last push of main after a merge.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DeployListVariablesResult,
  DeployProjectSettings,
  DeployServiceKind,
  DeploySetupStep,
  DeployVariableInput,
  GraphNodeStatus,
  ReadinessService,
  NeededFromYou as NeededItem,
  VercelStatus,
} from '../../../shared/types/deploy';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { NeededFromYou } from './NeededFromYou';
import { VariableDialog } from './VariableDialog';
import type { DeployEnv } from './useDeployEnv';
import { displayUrl, formatRelative, isWebUrl, LinkButton, StatusMark, useDeployErrorText } from './status';

/** Push failures with their own text; any other kind uses the shared deploy error text. */
const PUSH_ERROR_KINDS: ReadonlySet<string> = new Set(['conflict', 'permissions', 'no-connection', 'unavailable']);

const SERVICE_KINDS: DeployServiceKind[] = ['redis', 'blob'];
const isServiceKind = (k: string): k is DeployServiceKind => k === 'redis' || k === 'blob';

const STEPS: DeploySetupStep[] = ['repo', 'push', 'vercel', 'done'];
const TARGETS: ReadonlySet<string> = new Set(['production', 'preview', 'development']);

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

function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Notice({ tone, children }: { tone: 'attention' | 'info'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'border-l-2 bg-muted px-3 py-2 text-sm',
        tone === 'attention' ? 'border-destructive text-foreground' : 'border-foreground text-muted-foreground'
      )}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <dt className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export interface EnvironmentTabProps {
  projectId: string;
  /** Opens the GitHub sign-in dialog the Deploy page owns. */
  onConnectGitHub: () => void;
  env: DeployEnv;
  productionUrl?: string | null;
  /** What the readiness scan found the project needs from Vercel. */
  services?: ReadinessService[];
}

export function EnvironmentTab({ projectId, env, productionUrl, services = [], onConnectGitHub }: EnvironmentTabProps) {
  const { t, i18n } = useTranslation(['deploy']);
  const errorText = useDeployErrorText();
  const pushErrorText = (kind: string | undefined): string =>
    kind && PUSH_ERROR_KINDS.has(kind) ? t(`deploy:push.errors.${kind}`) : errorText(kind);
  const { state } = env;
  const settings = state?.settings ?? null;
  const setupRunning = !!state?.setupRunning;
  const servicesRunning = state?.servicesRunning ?? [];
  const databaseRunning = !!state?.databaseRunning;
  const lastSetup = state?.lastSetup;

  const [vercel, setVercel] = useState<VercelStatus | null>(null);
  const [team, setTeam] = useState<string | null | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<{ name?: string } | null>(null);
  const [variables, setVariables] = useState<DeployListVariablesResult | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Re-read on returning to the app: the Vercel sign-in finishes in the browser
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.resolve(window.electronAPI.vercel.status())
        .then((r) => {
          if (!cancelled && r.success && r.data) setVercel(r.data);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
    };
  }, []);

  const hasVariables = !!settings?.repo && !!settings?.vercel;
  const loadVariables = useCallback(async () => {
    try {
      const r = await window.electronAPI.deploy.listVariables(projectId);
      setVariables(r.success && r.data ? r.data : { ok: false, kind: 'unknown', message: '' });
    } catch {
      setVariables({ ok: false, kind: 'unknown', message: '' });
    }
  }, [projectId]);
  // Re-read once a database is added: it brings its own variables (DATABASE_URL, …)
  const databaseAddedAt = settings?.database?.addedAt;
  const servicesAdded = Object.keys(settings?.services ?? {}).sort().join(',');
  useEffect(() => {
    if (hasVariables) void loadVariables();
  }, [hasVariables, databaseAddedAt, servicesAdded, loadVariables]);

  if (!state) {
    return <p className="text-sm text-muted-foreground">{t('deploy:env.loading')}</p>;
  }

  const teams = vercel?.connected ? (vercel.teams ?? []) : [];
  const pickTeam = teams.length > 0 && !settings?.vercel;
  const chosenTeam = team !== undefined ? team : (settings?.vercelTeamId ?? null);
  const repoName = settings?.repo ? `${settings.repo.owner}/${settings.repo.repo}` : undefined;

  // A sign-in asked for by an earlier run is done once Vercel is connected
  const open = (n: NeededItem) => !acknowledged.has(n.id) && !(n.kind === 'vercel-sign-in' && vercel?.connected);
  const needed: NeededItem[] = [
    ...(lastSetup?.needed ?? []),
    ...(state.lastDatabase && !state.lastDatabase.ok && 'needed' in state.lastDatabase && !settings?.database ? [state.lastDatabase.needed] : []),
    ...SERVICE_KINDS.flatMap((k) => {
      const last = state.lastServices?.[k];
      return last && !last.ok && 'needed' in last && !settings?.services?.[k] ? [last.needed] : [];
    }),
  ].filter(open);

  const setupDone = !!settings?.enabled;
  const setupFailed = !!lastSetup?.error;
  const setupWaiting = (lastSetup?.needed ?? []).some((n) => n.kind !== 'public-repo-warning' && open(n));
  const showSetup = !setupDone || setupRunning || (lastSetup && lastSetup.step !== 'done');
  const current = setupRunning ? (env.progress ?? undefined) : lastSetup?.step;

  const vercelScope = settings?.vercel?.teamId
    ? vercel?.teams?.find((x) => x.id === settings.vercel?.teamId)?.slug
    : vercel?.user?.username;
  const vercelUrl = settings?.vercel && vercelScope ? `https://vercel.com/${vercelScope}/${settings.vercel.projectName}` : undefined;

  const databaseError = state.lastDatabase && !state.lastDatabase.ok && 'error' in state.lastDatabase && !settings?.database ? state.lastDatabase.error : undefined;
  const push = state.lastPush;

  const saveVariable = async (input: DeployVariableInput) => {
    const r = await window.electronAPI.deploy.setVariable(projectId, input);
    return r.success && r.data ? r.data : null;
  };

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
          {pickTeam && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm text-foreground">{t('deploy:setup.team')}</legend>
              <div className="flex flex-wrap">
                {[{ id: null as string | null, label: vercel?.user?.username ? t('deploy:setup.personal', { name: vercel.user.username }) : t('deploy:setup.personalNoName') }, ...teams.map((x) => ({ id: x.id as string | null, label: x.name || x.slug }))].map((opt) => (
                  <button
                    key={opt.id ?? '__personal'}
                    type="button"
                    aria-pressed={chosenTeam === opt.id}
                    disabled={setupRunning}
                    onClick={() => setTeam(opt.id)}
                    className={cn(
                      '-ml-px min-h-11 border border-foreground px-3.5 text-sm first:ml-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                      chosenTeam === opt.id ? 'bg-foreground text-background' : 'bg-transparent text-foreground hover:bg-muted'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div>
            <Button
              disabled={setupRunning}
              onClick={() => void env.setUp(pickTeam ? { vercelTeamId: chosenTeam } : undefined)}
            >
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
        setupRunning={setupRunning}
        databaseRunning={databaseRunning || servicesRunning.length > 0}
        onChooseProject={(choice) => void env.chooseVercelProject(choice)}
        onAcknowledge={(id) => setAcknowledged((s) => new Set([...s, id]))}
        onAddValue={(name) => setDialog({ name })}
        onConnectGitHub={onConnectGitHub}
        onAcceptTerms={(integration) => {
          if (integration && isServiceKind(integration)) {
            if (!servicesRunning.includes(integration)) void env.addService(integration, true);
          } else if (!databaseRunning) void env.addDatabase(true);
        }}
      />

      {(settings?.repo || settings?.vercel || settings?.database) && (
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
            {settings.vercel && (
              <Row label={t('deploy:exists.vercel')}>
                {vercelUrl ? (
                  <LinkButton url={vercelUrl} mono>
                    {settings.vercel.projectName}
                  </LinkButton>
                ) : (
                  <span className="font-mono text-[13px]">{settings.vercel.projectName}</span>
                )}
              </Row>
            )}
            {isWebUrl(productionUrl) && (
              <Row label={t('deploy:exists.production')}>
                <LinkButton url={productionUrl} mono>
                  {displayUrl(productionUrl)}
                </LinkButton>
              </Row>
            )}
            {settings.vercel && (
              <Row label={t('deploy:exists.database')}>
                {settings.database ? (
                  <span>{t('deploy:database.neon')}</span>
                ) : (
                  <span className="text-muted-foreground">{t('deploy:database.none')}</span>
                )}
              </Row>
            )}
          </dl>
        </Section>
      )}

      {settings?.vercel && !settings.database && (
        <Section id="deploy-database-title" title={t('deploy:database.title')}>
          <p className="text-sm text-muted-foreground">{t('deploy:database.description')}</p>
          <div>
            <Button disabled={databaseRunning} onClick={() => void env.addDatabase()}>
              {databaseRunning ? t('deploy:database.adding') : t('deploy:database.add')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('deploy:database.previewNote')}</p>
          {databaseRunning && state.databaseDownload && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-foreground" role="status">
                {t('deploy:database.downloading', { percent: state.databaseDownload.percent })}
              </p>
              <Button variant="outline" size="sm" onClick={env.cancelDatabase}>
                {t('deploy:database.cancel')}
              </Button>
            </div>
          )}
          {databaseError && databaseError.kind !== 'cancelled' && !databaseRunning && (
            <Notice tone="attention">{errorText(databaseError.kind)}</Notice>
          )}
        </Section>
      )}

      {settings?.vercel && services.some((s) => s.kind !== 'postgres') && (
        <Section id="deploy-services-title" title={t('deploy:services.title')}>
          <p className="text-sm text-muted-foreground">{t('deploy:services.description')}</p>
          <ul aria-label={t('deploy:services.title')} className="flex flex-col border border-foreground">
            {services
              .filter((s) => s.kind !== 'postgres')
              .map((s) => {
                const kind = s.managed && isServiceKind(s.kind) ? s.kind : undefined;
                const added = kind ? !!settings.services?.[kind] : false;
                const running = kind ? servicesRunning.includes(kind) : false;
                const download = kind ? state.serviceDownload?.[kind] : undefined;
                const last = kind ? state.lastServices?.[kind] : undefined;
                const error = !added && !running && last && !last.ok && 'error' in last && last.error.kind !== 'cancelled' ? last.error : undefined;
                return (
                  <li key={`${s.kind}:${s.name}`} className="flex flex-col gap-1.5 border-b border-border px-3 py-2 last:border-b-0">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <span className="min-w-0 flex-1 text-sm text-foreground">{s.name}</span>
                      {kind && added && <span className="bg-muted px-1.5 font-mono text-[11px] text-foreground">{t('deploy:services.added')}</span>}
                      {kind && !added && (
                        <Button size="sm" disabled={running} onClick={() => void env.addService(kind)}>
                          {running ? t('deploy:services.adding') : t('deploy:services.add')}
                        </Button>
                      )}
                    </div>
                    {!s.managed && s.reason && <p className="text-xs text-muted-foreground">{s.reason}</p>}
                    {kind && running && download && (
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-sm text-foreground" role="status">
                          {t('deploy:services.downloading', { percent: download.percent })}
                        </p>
                        <Button variant="outline" size="sm" onClick={() => env.cancelService(kind)}>
                          {t('deploy:services.cancel')}
                        </Button>
                      </div>
                    )}
                    {error && <Notice tone="attention">{errorText(error.kind)}</Notice>}
                  </li>
                );
              })}
          </ul>
        </Section>
      )}

      {hasVariables && (
        <Section id="deploy-variables-title" title={t('deploy:variables.title')}>
          {variables === null ? (
            <p className="text-sm text-muted-foreground">{t('deploy:variables.loading')}</p>
          ) : !variables.ok ? (
            <Notice tone="attention">{errorText(variables.kind)}</Notice>
          ) : variables.variables.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('deploy:variables.empty')}</p>
          ) : (
            <ul aria-label={t('deploy:variables.title')} className="flex flex-col border border-foreground">
              {variables.variables.map((v) => (
                <li key={v.name} className="flex flex-wrap items-baseline gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">{v.name}</span>
                  {v.targets.map((target) => (
                    <span key={target} className="border border-border px-1.5 font-mono text-[11px] text-muted-foreground">
                      {TARGETS.has(target) ? t(`deploy:variables.target.${target}`) : target}
                    </span>
                  ))}
                  {v.inGitHub && <span className="bg-muted px-1.5 font-mono text-[11px] text-foreground">{t('deploy:variables.inGitHub')}</span>}
                </li>
              ))}
            </ul>
          )}
          {variables?.ok && variables.githubUnavailable && (
            <p className="text-xs text-muted-foreground">{t('deploy:variables.githubUnavailable')}</p>
          )}
          {savedNote && <p role="status" className="text-sm text-muted-foreground">{savedNote}</p>}
          <div>
            <Button variant="outline" onClick={() => setDialog({})}>
              {t('deploy:variables.add')}
            </Button>
          </div>
        </Section>
      )}

      <VariableDialog
        open={dialog !== null}
        initialName={dialog?.name}
        onClose={() => setDialog(null)}
        onSave={saveVariable}
        onSaved={(name, result) => {
          setDialog(null);
          // The value is there now: its "needed" item goes without running setup again
          const done = needed.filter((n) => n.kind === 'variable' && n.variable === name).map((n) => n.id);
          if (done.length > 0) setAcknowledged((s) => new Set([...s, ...done]));
          setSavedNote(result.github === 'ok' ? t('deploy:variables.savedBoth', { name }) : t('deploy:variables.saved', { name }));
          void loadVariables();
        }}
      />
    </div>
  );
}
