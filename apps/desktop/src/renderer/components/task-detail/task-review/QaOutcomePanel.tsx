/**
 * Why QA ended without approval: the reason in plain words and what blocked
 * it (security gates, design check, the reviewer's issues), with the next
 * steps. A design finding the design system should allow can be allowed here.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { Button } from '../../ui/button';
import { submitReview } from '../../../stores/task-store';
import type { QaOutcomeInfo, Task } from '../../../../shared/types';

const SOURCES = ['security', 'design', 'qa'] as const;

/** A regular expression matching exactly this text. Pure — tested directly. */
export function exactPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The matches Allow already wrote to the tokens. Compared as text: agents can edit the
 * tokens, and running their regular expressions here could hang the window. Pure.
 */
function matchesAllowed(matches: string[], patterns: Array<{ pattern: string }> = []): string[] {
  return matches.filter((match) => patterns.some(({ pattern }) => pattern === exactPattern(match)));
}

export function QaOutcomePanel({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const [outcome, setOutcome] = useState<QaOutcomeInfo | null>(null);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getTaskWorkspace?.(task.id, task.projectId)
      .then(async (r) => {
        if (cancelled || !r?.success) return;
        const loaded = r.data?.qaOutcome ?? null;
        setOutcome(loaded);
        // Allowed earlier (the outcome predates it): say so instead of offering it again
        const matches = (loaded?.blocking ?? []).flatMap((b) => (b.source === 'design' && b.match ? [b.match] : []));
        if (!matches.length) return;
        const design = await window.electronAPI.design.get(task.projectId);
        if (!cancelled && design.success) setAllowed(new Set(matchesAllowed(matches, design.data?.tokens?.allowedPatterns)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, task.status]);

  const allow = useCallback(
    async (match: string) => {
      setError(null);
      const design = window.electronAPI.design;
      const current = await design.get(task.projectId);
      if (!current.success || !current.data?.tokens) {
        setError(t('qaOutcome.noTokens'));
        return;
      }
      const tokens = current.data.tokens;
      const pattern = exactPattern(match);
      if (!(tokens.allowedPatterns ?? []).some((p) => p.pattern === pattern)) {
        const saved = await design.save(task.projectId, {
          tokens: { ...tokens, allowedPatterns: [...(tokens.allowedPatterns ?? []), { pattern, message: t('qaOutcome.allowedBy', { title: task.title }) }] },
        });
        if (!saved.success) {
          setError(saved.error ?? t('qaOutcome.allowFailed'));
          return;
        }
      }
      setAllowed((prev) => new Set(prev).add(match));
    },
    [task.projectId, task.title, t],
  );

  const rerun = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await submitReview(task.id, false, undefined, undefined, { rerunOnly: true });
      if (!started) setError(t('qaOutcome.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (task.status !== 'human_review') return null;
  // A run from before QA recorded its outcome: say where to look, and offer a fresh run
  if (!outcome && task.reviewReason === 'errors') {
    return (
      <section aria-labelledby="qa-outcome" className="border border-foreground">
        <header className="border-b border-l-2 border-b-border border-l-[var(--vt-signal)] px-4 py-3">
          <h3 id="qa-outcome" className="text-sm font-semibold text-foreground">{t('qaOutcome.title')}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('qaOutcome.unrecorded')}</p>
        </header>
        {error && <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error}</p>}
        <footer className="border-t border-border px-4 py-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void rerun()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t('qaOutcome.rerun')}
          </Button>
        </footer>
      </section>
    );
  }
  if (!outcome) return null;
  const changedFiles = outcome.reviewerChangedFiles ?? [];
  const changedNotice = changedFiles.length > 0 && (
    <p className="px-4 py-2 text-xs text-muted-foreground">
      {t('qaOutcome.reviewerChanged', { count: changedFiles.length, files: changedFiles.join(', ') })}
    </p>
  );
  // Approved: nothing blocked it, but files the reviewer touched are still worth a look
  if (outcome.approved) {
    return changedNotice ? <section aria-label={t('qaOutcome.title')} className="border border-border">{changedNotice}</section> : null;
  }

  const reasonText = outcome.checksRepeat
    ? t('qaOutcome.reason.checksRepeat')
    : outcome.reviewerApproved
    ? t('qaOutcome.reason.checksBlocked')
    : t(`qaOutcome.reason.${outcome.reason ?? 'max_iterations'}`, { count: outcome.iterations, error: outcome.error ?? '' });
  const designMatches = outcome.blocking.filter((b) => b.source === 'design' && b.match).map((b) => b.match as string);

  return (
    <section aria-labelledby="qa-outcome" className="border border-foreground">
      <header className="border-b border-l-2 border-b-border border-l-[var(--vt-signal)] px-4 py-3">
        <h3 id="qa-outcome" className="text-sm font-semibold text-foreground">{t('qaOutcome.title')}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{reasonText}</p>
      </header>

      {outcome.blocking.length > 0 && (
        <div className="space-y-4 px-4 py-3">
          {SOURCES.map((source) => {
            const items = outcome.blocking.filter((b) => b.source === source);
            if (!items.length) return null;
            return (
              <div key={source}>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  {t(`qaOutcome.sources.${source}`, { count: items.length })}
                </p>
                <ul className="border-t border-border">
                  {items.slice(0, 12).map((item, i) => (
                    <li key={`${i}-${item.title}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0 text-sm">
                      <span className="min-w-0 flex-1 text-foreground">{item.title}</span>
                      {item.location && <span className="font-mono text-[11px] text-muted-foreground">{item.location}</span>}
                      {item.source === 'design' && item.match && (
                        allowed.has(item.match) ? (
                          <span className="font-mono text-[11px] text-muted-foreground">{t('qaOutcome.allowed')}</span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => void allow(item.match as string)}>
                            {t('qaOutcome.allow', { match: item.match })}
                          </Button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
                {items.length > 12 && <p className="mt-1 text-xs text-muted-foreground">{t('qaOutcome.more', { count: items.length - 12 })}</p>}
              </div>
            );
          })}
        </div>
      )}

      {changedNotice}

      {error && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p>}

      <footer className="space-y-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {designMatches.length ? t('qaOutcome.nextWithDesign') : t('qaOutcome.next')}
        </p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void rerun()}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t('qaOutcome.rerun')}
        </Button>
      </footer>
    </section>
  );
}
