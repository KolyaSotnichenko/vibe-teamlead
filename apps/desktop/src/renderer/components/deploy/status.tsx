/**
 * Status marks and small formatters shared by the Deploy view.
 * Design system: radius 0, ink for done, vermilion only for a failure, the word always present for screen readers.
 */
import { useTranslation } from 'react-i18next';
import type { DeployStatus, GitHubError, GraphNodeStatus, ReadinessBlocker } from '../../../shared/types/deploy';
import { cn } from '../../lib/utils';

/** A run, job or step as a graph status (same rules as the main process's run graph). */
export function toNodeStatus(status: DeployStatus, conclusion?: string): GraphNodeStatus {
  if (status === 'in_progress') return 'running';
  if (status !== 'completed') return 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'skipped';
  }
}

/** Square mark: outline (queued), turning outline (running), ink ✓, vermilion ✕, muted – (skipped, cancelled), vermilion-outlined ! (attention: waiting for the owner). */
export function StatusMark({ status, className }: { status: GraphNodeStatus | 'attention'; className?: string }) {
  const { t } = useTranslation(['deploy']);
  return (
    <span data-marker={status} className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex items-center justify-center font-mono text-[10px] font-semibold leading-none',
          status === 'queued' && 'h-3 w-3 border border-muted-foreground',
          status === 'running' && 'h-3 w-3 animate-spin border-2 border-foreground border-t-transparent motion-reduce:animate-none',
          status === 'success' && 'h-4 w-4 bg-foreground text-background',
          status === 'failure' && 'h-4 w-4 bg-destructive text-destructive-foreground',
          (status === 'skipped' || status === 'cancelled') && 'h-4 w-4 border border-border text-muted-foreground',
          status === 'attention' && 'h-4 w-4 border border-destructive text-destructive'
        )}
      >
        {status === 'success' ? '✓' : status === 'failure' ? '✕' : status === 'skipped' || status === 'cancelled' ? '–' : status === 'attention' ? '!' : ''}
      </span>
      <span className="sr-only">{t(`deploy:status.${status}`)}</span>
    </span>
  );
}

/** Elapsed time as `0:38`, `1:12`, `1:02:03`; undefined without a start. */
export function formatDuration(startedAt?: string, completedAt?: string, now = Date.now()): string | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const total = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "5 minutes ago" in the UI language. */
export function formatRelative(iso: string, language: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

/** `14:05` in the UI language, 24-hour. */
export function formatClock(iso: string, language: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** What to tell the owner about a GitHub failure, by kind (the page banner and the job log use the same words). */
export function useGitHubErrorText() {
  const { t, i18n } = useTranslation(['deploy']);
  return (error: GitHubError): string => {
    if (error.kind === 'rate-limit') {
      const time = error.resetAt ? formatClock(error.resetAt, i18n.language) : '';
      return time ? t('deploy:errors.rate-limit', { time }) : t('deploy:errors.rateLimitNoTime');
    }
    return t(`deploy:errors.${error.kind}`);
  };
}

/** Error kinds the Environment tab has words for (setup, variables, database, Vercel, GitHub, the push after a merge). */
const DEPLOY_ERROR_KINDS: ReadonlySet<string> = new Set([
  'no-connection',
  'permissions',
  'forbidden',
  'not-found',
  'rate-limit',
  'unavailable',
  'git-not-connected',
  'conflict',
  'bad-request',
  'invalid',
  'not-set-up',
  'auth',
  'cli',
  'timeout',
  'saved-failed',
  'unknown',
]);

/** Words for a deploy error kind; main's English message is never shown. */
export function useDeployErrorText() {
  const { t } = useTranslation(['deploy']);
  return (kind: string | undefined): string => t(`deploy:env.errors.${kind && DEPLOY_ERROR_KINDS.has(kind) ? kind : 'unknown'}`);
}

/** Code and workflow blockers only: an old saved result may still hold the removed Deploy's `unsupported` ones. */
export const isCiBlocker = (b: ReadinessBlocker): boolean => b.kind === 'code' || b.kind === 'workflow';

/** Only http(s) URLs become links; anything else from GitHub or a host is not shown as one. */
export function isWebUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Opens an http(s) URL in the browser; a refusal is ignored (nothing to show for it). */
export function openWebUrl(url: string): void {
  if (!isWebUrl(url)) return;
  void Promise.resolve(window.electronAPI.openExternal(url)).catch(() => undefined);
}

/** https only (no credentials): for links whose source is a third party, such as Marketplace policy links. */
export function isHttpsUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** A text link that opens a web URL in the browser (underlined, focus ring). */
export function LinkButton({ url, children, mono }: { url: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => openWebUrl(url)}
      className={cn(
        'text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mono && 'font-mono text-[13px]'
      )}
    >
      {children}
    </button>
  );
}

/** Host and path of a URL, without the scheme, for display. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
