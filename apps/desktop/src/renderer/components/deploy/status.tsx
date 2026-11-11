/**
 * Status marks and small formatters shared by the Deploy view.
 * Design system: radius 0, ink for done, vermilion only for a failure, the word always present for screen readers.
 */
import { useTranslation } from 'react-i18next';
import type { DeployStatus, GitHubError, GraphNodeStatus } from '../../../shared/types/deploy';
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

/** Square mark: outline (queued), turning outline (running), ink ✓, vermilion ✕, muted – (skipped, cancelled). */
export function StatusMark({ status, className }: { status: GraphNodeStatus; className?: string }) {
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
          (status === 'skipped' || status === 'cancelled') && 'h-4 w-4 border border-border text-muted-foreground'
        )}
      >
        {status === 'success' ? '✓' : status === 'failure' ? '✕' : status === 'skipped' || status === 'cancelled' ? '–' : ''}
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

/** Host and path of a URL, without the scheme, for display. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
