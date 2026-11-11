/**
 * Sidebar → Deploy. Runs: the project's GitHub Actions runs, live (layout B: runs on the left, the
 * selected run's graph and the clicked job on the right); polling runs in the main process while this
 * page is open and the window is visible. Environment: set up deploy, what exists, variables, database.
 * Until deploy is set up, both tabs offer Set up deploy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeployRunsState, GitHubError } from '../../../shared/types/deploy';
import { GITHUB_APP_INSTALL_URL, GITHUB_INSTALLATIONS_SETTINGS_URL } from '../../../shared/constants/github';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { GitHubOAuthFlow } from '../project-settings/GitHubOAuthFlow';
import { EmptyState } from '../task-detail/workspace/workspace-ui';
import { cn } from '../../lib/utils';
import { RunsList } from './RunsList';
import { RunGraph } from './RunGraph';
import { JobPanel } from './JobPanel';
import { EnvironmentTab } from './EnvironmentTab';
import { DeployChecklist } from './DeployChecklist';
import { useDeployEnv } from './useDeployEnv';
import { displayUrl, isWebUrl, openWebUrl, useGitHubErrorText } from './status';

const ATTENTION: ReadonlySet<GitHubError['kind']> = new Set(['no-connection', 'permissions', 'not-found']);

/** On not-found: true once GitHub confirms the app is not installed on the repository's owner (false while unknown or on error). */
function useAppNotInstalled(repo: string | undefined, kind: GitHubError['kind']): boolean {
  const [notInstalled, setNotInstalled] = useState(false);
  useEffect(() => {
    setNotInstalled(false);
    if (kind !== 'not-found' || !repo) return;
    let cancelled = false;
    Promise.resolve(window.electronAPI.getGitHubAppAccess(repo))
      .then((result) => {
        if (!cancelled && result.success && result.data && !result.data.installed) setNotInstalled(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo, kind]);
  return notInstalled;
}

function ErrorNotice({ error, repo, onConnect }: { error: GitHubError; repo?: string; onConnect: () => void }) {
  const { t } = useTranslation(['deploy']);
  const errorText = useGitHubErrorText();
  const notInstalled = useAppNotInstalled(repo, error.kind);
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 border-l-2 bg-muted px-3 py-2 text-sm',
        ATTENTION.has(error.kind) ? 'border-destructive text-foreground' : 'border-foreground text-muted-foreground'
      )}
    >
      <span className="min-w-0 flex-1">{errorText(error)}</span>
      {error.kind === 'no-connection' && (
        <Button size="sm" onClick={onConnect}>
          {t('deploy:errors.connect')}
        </Button>
      )}
      {/* A private repository the app cannot reach arrives as 404: install the app when it is not on the owner */}
      {error.kind === 'not-found' && notInstalled ? (
        <Button size="sm" variant="outline" onClick={() => openWebUrl(GITHUB_APP_INSTALL_URL)}>
          {t('deploy:errors.installApp')}
        </Button>
      ) : (error.kind === 'permissions' || error.kind === 'not-found') && (
        <Button size="sm" variant="outline" onClick={() => openWebUrl(GITHUB_INSTALLATIONS_SETTINGS_URL)}>
          {t('deploy:errors.manageAccess')}
        </Button>
      )}
    </div>
  );
}

export function DeployPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation(['deploy']);
  const [state, setState] = useState<DeployRunsState | null>(null);
  const [pickedRunId, setPickedRunId] = useState<number | undefined>();
  const [nodeKey, setNodeKey] = useState<string | undefined>();
  const [signingIn, setSigningIn] = useState(false);
  const [tab, setTab] = useState<'runs' | 'environment'>('runs');
  // Bumped after a GitHub sign-in so the checklist reads the accounts again
  const [accountsKey, setAccountsKey] = useState(0);
  // Setup may have created the repository: the poller looks again
  const restartRuns = useCallback(() => void window.electronAPI.deploy.startRuns(projectId, selectedRef.current), [projectId]);
  const env = useDeployEnv(projectId, restartRuns);
  const notSetUp = !!env.state && !env.state.settings?.enabled;

  const runs = state?.runs ?? [];
  // A picked run that dropped off the list falls back to the poller's choice, as in the main process
  const picked = runs.some((r) => r.id === pickedRunId) ? pickedRunId : undefined;
  const selectedId = picked ?? state?.selected?.runId ?? runs[0]?.id;
  const selectedRef = useRef<number | undefined>(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const deploy = window.electronAPI.deploy;
    const unsubscribe = deploy.onRunsUpdate((next) => {
      if (next.projectId === projectId) setState(next);
    });
    const start = () => void deploy.startRuns(projectId, selectedRef.current);
    const stop = () => void deploy.stopRuns(projectId);
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      stop();
    };
  }, [projectId]);

  const selectRun = (runId: number) => {
    if (runId === selectedId) return;
    setPickedRunId(runId);
    setNodeKey(undefined);
    void window.electronAPI.deploy.selectRun(projectId, runId);
  };

  const run = runs.find((r) => r.id === selectedId);
  // Only the graph of the run on screen: while a switch is under way, the old run's graph stays hidden
  const selected = state?.selected && state.selected.runId === selectedId ? state.selected : undefined;
  const node = selected?.graph.columns.flatMap((c) => c.nodes).find((n) => n.key === nodeKey);

  let body: React.ReactNode;
  if (!state) {
    body = <p className="text-sm text-muted-foreground">{t('deploy:loading')}</p>;
  } else if (!state.repo) {
    body = <EmptyState title={t('deploy:empty.noRepo')} body={t('deploy:empty.noRepoBody')} />;
  } else if (runs.length === 0) {
    body = state.error ? null : <EmptyState title={t('deploy:empty.noRuns')} body={t('deploy:empty.noRunsBody')} />;
  } else {
    body = (
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-4">
        <ScrollArea className="min-h-0" viewportClassName="[&>div]:!block">
          <RunsList runs={runs} selectedId={selectedId} onSelect={selectRun} />
        </ScrollArea>
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
          {run && (
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-foreground">{run.number > 0 ? `#${run.number} ${run.title}` : run.title}</h2>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{`${run.event} · ${run.branch} · ${run.sha.slice(0, 7)}`}</span>
                  {isWebUrl(run.htmlUrl) && (
                    <button
                      type="button"
                      onClick={() => openWebUrl(run.htmlUrl)}
                      className="text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('deploy:run.openOnGitHub')}
                    </button>
                  )}
                </div>
              </div>
              {isWebUrl(state.productionUrl) && (
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{t('deploy:run.production')}</span>
                  <button
                    type="button"
                    onClick={() => openWebUrl(state.productionUrl as string)}
                    className="font-mono text-[13px] font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {displayUrl(state.productionUrl as string)}
                  </button>
                </div>
              )}
            </div>
          )}
          {selected && run ? (
            <>
              {selected.graph.columns.length > 0 ? (
                <RunGraph graph={selected.graph} jobs={selected.jobs} selectedKey={nodeKey} onSelect={(n) => setNodeKey(n.key === nodeKey ? undefined : n.key)} />
              ) : (
                <p className="text-sm text-muted-foreground">{t('deploy:graph.empty')}</p>
              )}
              {node ? (
                <JobPanel key={node.key} projectId={projectId} run={run} node={node} jobs={selected.jobs} pollKey={state.nextPollAt} />
              ) : (
                selected.graph.columns.length > 0 && <p className="text-sm text-muted-foreground">{t('deploy:job.pick')}</p>
              )}
            </>
          ) : state.error?.kind === 'rate-limit' ? (
            // The poller does not fetch a newly picked run while rate-limited: say so rather than "loading"
            <p role="status" className="text-sm text-muted-foreground">{t('deploy:graph.paused')}</p>
          ) : (
            <p role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden="true" className="vt-breathe inline-block h-2 w-2 bg-foreground" />
              {t('deploy:graph.loading')}
            </p>
          )}
        </div>
      </div>
    );
  }

  // What is still missing, numbered, on top of both tabs (hidden once all is done)
  const checklist = env.state ? (
    <DeployChecklist
      setUp={!notSetUp}
      refreshKey={accountsKey}
      onConnectGitHub={() => setSigningIn(true)}
      onSetUp={() => setTab('environment')}
    />
  ) : null;

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label={t('deploy:title')} className="flex border-b border-border px-6">
        {(['runs', 'environment'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`deploy-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`deploy-panel-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              'min-h-11 border-b-2 px-3.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === id ? 'border-foreground font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`deploy:tabs.${id}`)}
          </button>
        ))}
      </div>
      {tab === 'runs' ? (
        <div role="tabpanel" id="deploy-panel-runs" aria-labelledby="deploy-tab-runs" className="flex min-h-0 flex-1 flex-col gap-4 p-6">
          {checklist}
          {state?.repo && state.error && (
            <ErrorNotice
              error={state.error}
              repo={`${state.repo.owner}/${state.repo.repo}`}
              onConnect={() => setSigningIn(true)}
            />
          )}
          {body}
        </div>
      ) : (
        <div role="tabpanel" id="deploy-panel-environment" aria-labelledby="deploy-tab-environment" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          {checklist && <div className="mb-6">{checklist}</div>}
          <EnvironmentTab projectId={projectId} env={env} productionUrl={state?.productionUrl} onConnectGitHub={() => setSigningIn(true)} />
        </div>
      )}

      <Dialog open={signingIn} onOpenChange={setSigningIn}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deploy:signIn.title')}</DialogTitle>
            <DialogDescription>{t('deploy:signIn.description')}</DialogDescription>
          </DialogHeader>
          {signingIn && (
            <GitHubOAuthFlow
              onSuccess={() => {
                setSigningIn(false);
                setAccountsKey((k) => k + 1);
                void window.electronAPI.deploy.startRuns(projectId, selectedRef.current);
                void env.refresh();
              }}
              onCancel={() => setSigningIn(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
