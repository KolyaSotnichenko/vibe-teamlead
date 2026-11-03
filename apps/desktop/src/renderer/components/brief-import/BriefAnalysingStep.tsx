/**
 * Step 2: the brief analyst is working. Pending row (breathing ink square, no
 * spinner, no vermilion), elapsed time, the last progress lines in mono, Cancel.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatStopwatch } from './brief-review-model';
import { secondaryButton } from './brief-ui';

export const PROGRESS_LINES_SHOWN = 6;

export function BriefAnalysingStep({
  sourceLabel,
  startedAt,
  lines,
  cancelling,
  onCancel,
}: {
  /** File name, or "your description" */
  sourceLabel: string;
  startedAt: number;
  lines: string[];
  cancelling: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['tasks']);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = formatStopwatch((now - startedAt) / 1000);
  const shown = lines.slice(-PROGRESS_LINES_SHOWN);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div role="status" aria-busy="true" className="flex items-start gap-3 border-l-2 border-foreground bg-muted px-4 py-3">
        <span aria-hidden className="vt-breathe mt-1.5 h-2 w-2 shrink-0 bg-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {t('tasks:briefImport.analysing.title', { source: sourceLabel })}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('tasks:briefImport.analysing.body')}</p>
        </div>
        <div className="shrink-0 text-right">
          <span className="block text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {t('tasks:briefImport.analysing.elapsed')}
          </span>
          <time className="font-mono text-[19px] font-medium tabular-nums text-foreground">{elapsed}</time>
        </div>
      </div>

      <section aria-labelledby="brief-progress-heading">
        <div className="flex items-end justify-between border-b border-foreground pb-2">
          <h3 id="brief-progress-heading" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">
            {t('tasks:briefImport.analysing.logHeading')}
          </h3>
          <span className="font-mono text-xs text-muted-foreground">
            {t('tasks:briefImport.analysing.lineCount', { count: lines.length })}
          </span>
        </div>
        <ol aria-live="polite" aria-relevant="additions" className="min-h-[168px] font-mono text-[12.5px] leading-relaxed">
          {shown.length === 0 ? (
            <li className="py-2 text-muted-foreground">{t('tasks:briefImport.analysing.waitingForFirst')}</li>
          ) : (
            shown.map((line, i) => {
              const index = lines.length - shown.length + i;
              const latest = i === shown.length - 1;
              return (
                <li key={`${index}-${line}`} className="flex gap-3 border-b border-border py-1.5 last:border-b-0">
                  <span aria-hidden className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className={latest ? 'text-foreground' : 'text-muted-foreground'}>{line}</span>
                </li>
              );
            })
          )}
        </ol>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="max-w-prose text-sm text-muted-foreground">{t('tasks:briefImport.analysing.nothingYet')}</p>
        <button type="button" onClick={onCancel} disabled={cancelling} className={secondaryButton}>
          {cancelling ? t('tasks:briefImport.analysing.cancelling') : t('tasks:briefImport.analysing.cancel')}
        </button>
      </div>
    </div>
  );
}
