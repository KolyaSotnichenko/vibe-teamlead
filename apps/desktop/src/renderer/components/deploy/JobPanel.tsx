/**
 * Deploy → Runs: the clicked node's jobs — steps with status and duration, and once a job is
 * complete, its log (main sends the last 2 000 lines, ANSI codes stripped) with a link to the full log on GitHub.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeployJob, DeployJobLog, DeployRun, GraphNode } from '../../../shared/types/deploy';
import { cn } from '../../lib/utils';
import { StatusMark, displayUrl, formatDuration, isWebUrl, openWebUrl, toNodeStatus, useGitHubErrorText } from './status';

interface JobPanelProps {
  projectId: string;
  run: DeployRun;
  node: GraphNode;
  /** The selected run's jobs, live from the poller */
  jobs: DeployJob[];
  /** Changes on every poll; a log GitHub has not made yet is asked for again then */
  pollKey: string;
}

function LinkButton({ url, children }: { url: string | undefined; children: string }) {
  if (!isWebUrl(url)) return null;
  return (
    <button
      type="button"
      onClick={() => openWebUrl(url)}
      className="text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function JobLog({ projectId, job, fullLogUrl, pollKey }: { projectId: string; job: DeployJob; fullLogUrl: string; pollKey: string }) {
  const { t } = useTranslation(['deploy']);
  const errorText = useGitHubErrorText();
  /** The log, and the poll it was fetched in */
  const [entry, setEntry] = useState<{ jobId: number; log: DeployJobLog; poll: string } | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const pollRef = useRef(pollKey);
  pollRef.current = pollKey;
  const completed = job.status === 'completed';
  const log = entry?.jobId === job.id ? entry.log : undefined;
  // A log GitHub has not made yet, or a request GitHub may answer later, is asked for again on a later poll.
  // A request in flight is never cancelled or sent twice: a large log would otherwise never arrive.
  // A rate-limited log is asked for again once the limit has reset.
  const retryable =
    log?.state === 'pending' ||
    (log?.state === 'error' &&
      (log.error.kind === 'unavailable' ||
        (log.error.kind === 'rate-limit' && (!log.error.resetAt || Date.now() >= Date.parse(log.error.resetAt)))));
  const fetchKey = !log ? 'first' : retryable && entry?.poll !== pollKey ? pollKey : 'settled';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!completed || fetchKey === 'settled' || inFlight.current) return;
    inFlight.current = true;
    const jobId = job.id;
    const poll = pollRef.current;
    const settle = (next: DeployJobLog) => {
      inFlight.current = false;
      if (mounted.current) setEntry({ jobId, log: next, poll });
    };
    window.electronAPI.deploy
      .jobLog(projectId, jobId)
      .then((result) =>
        settle(result.success && result.data ? result.data : { state: 'error', error: { kind: 'unavailable', message: result.error ?? '' } })
      )
      .catch(() => settle({ state: 'error', error: { kind: 'unavailable', message: '' } }));
  }, [projectId, job.id, completed, fetchKey]);

  const text = log?.state === 'ready' ? log.text : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the end whenever the text changes
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [text]);

  if (!completed) return <p className="text-sm text-muted-foreground">{t('deploy:log.pending')}</p>;
  if (log?.state === 'pending') return <p className="text-sm text-muted-foreground">{t('deploy:log.preparing')}</p>;
  if (!log) return <p className="text-sm text-muted-foreground">{t('deploy:log.loading')}</p>;
  if (log.state === 'expired') {
    return (
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-sm text-muted-foreground">{t('deploy:log.expired')}</p>
        <LinkButton url={fullLogUrl}>{t('deploy:job.fullLog')}</LinkButton>
      </div>
    );
  }
  if (log.state === 'error') return <p className="text-sm text-foreground">{errorText(log.error)}</p>;
  return (
    <div className="flex flex-col gap-2">
      <section
        ref={scrollRef}
        aria-label={t('deploy:log.label', { job: job.name })}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log must be reachable by keyboard to scroll it
        tabIndex={0}
        className="vt-ink-surface max-h-96 overflow-auto border border-[var(--vt-ink-line)] bg-[var(--vt-ink)] p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <pre data-testid="job-log" className="whitespace-pre font-mono text-xs leading-relaxed text-[var(--vt-paper)]">
          {text}
        </pre>
      </section>
      <div>
        <LinkButton url={fullLogUrl}>{t('deploy:job.fullLog')}</LinkButton>
      </div>
    </div>
  );
}

export function JobPanel({ projectId, run, node, jobs, pollKey }: JobPanelProps) {
  const { t } = useTranslation(['deploy']);
  const nodeJobs = node.jobIds.map((id) => jobs.find((j) => j.id === id)).filter((j): j is DeployJob => j !== undefined);
  const [jobId, setJobId] = useState<number | undefined>(nodeJobs[0]?.id);
  const job = nodeJobs.find((j) => j.id === jobId) ?? nodeJobs[0];

  return (
    <section aria-label={node.label} className="flex flex-col gap-3 border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusMark status={node.status} />
        <h3 className="text-sm font-semibold text-foreground">{node.label}</h3>
        {job && (
          <span className="font-mono text-xs text-muted-foreground">{formatDuration(job.startedAt, job.completedAt) ?? ''}</span>
        )}
      </div>

      {nodeJobs.length > 1 && (
        <div className="flex flex-wrap gap-0 border-b border-border">
          {nodeJobs.map((j) => (
            <button
              key={j.id}
              type="button"
              aria-pressed={j.id === job?.id}
              onClick={() => setJobId(j.id)}
              className={cn(
                'flex min-h-9 items-center gap-2 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                j.id === job?.id ? 'border-b-2 border-foreground font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <StatusMark status={toNodeStatus(j.status, j.conclusion)} />
              {j.name}
            </button>
          ))}
        </div>
      )}

      {!job && (
        <div className="flex flex-col gap-2">
          {isWebUrl(node.deploymentUrl) && (
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{t('deploy:job.deployment')}</span>
              <LinkButton url={node.deploymentUrl}>{displayUrl(node.deploymentUrl)}</LinkButton>
            </div>
          )}
          {isWebUrl(node.logUrl) ? (
            <div>
              <LinkButton url={node.logUrl}>{t('deploy:job.deploymentLog')}</LinkButton>
            </div>
          ) : (
            !isWebUrl(node.deploymentUrl) && <p className="text-sm text-muted-foreground">{t('deploy:job.noDetails')}</p>
          )}
        </div>
      )}

      {job && (
        <>
          <ol aria-label={t('deploy:job.steps')} className="border border-border">
            {job.steps.map((step) => (
              <li key={step.number} className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 text-sm last:border-b-0">
                <StatusMark status={toNodeStatus(step.status, step.conclusion)} />
                <span className="min-w-0 flex-1 truncate">{step.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{formatDuration(step.startedAt, step.completedAt) ?? ''}</span>
              </li>
            ))}
            {job.steps.length === 0 && <li className="px-3 py-1.5 text-sm text-muted-foreground">{t('deploy:job.noSteps')}</li>}
          </ol>
          <JobLog key={job.id} projectId={projectId} job={job} fullLogUrl={`${run.htmlUrl}/job/${job.id}`} pollKey={pollKey} />
        </>
      )}
    </section>
  );
}
