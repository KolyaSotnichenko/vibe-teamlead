/**
 * Design system → Apply to the project: the design check QA runs on each task's new lines,
 * run over the whole UI (without a model). Shows where the code differs, then turns it into a
 * redesign brief the spec analyst splits into tasks. The owner reads the brief and the
 * proposed tasks before anything is created.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Wand2 } from 'lucide-react';

import type { DesignAudit, RedesignBrief } from '../../../shared/types';
import { BriefImportDialog } from '../brief-import';
import { Button } from '../ui/button';
import { SectionHeader } from '../task-detail/workspace/workspace-ui';

/** undefined: still checking; null: can't be checked (the system has no tokens) */
export function ApplyDesignSystem({ projectId, audit }: { projectId: string; audit: DesignAudit | null | undefined }) {
  const { t } = useTranslation(['common']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedesignBrief | null>(null);
  const [open, setOpen] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await window.electronAPI.design.redesignBrief(projectId);
      if (response.success && response.data) {
        setResult(response.data);
        setOpen(true);
      } else setError(response.error ?? t('context.design.apply.failed'));
    } finally {
      setBusy(false);
    }
  };

  const diff = !!audit && audit.findings > 0;
  const state = audit === undefined ? 'checking' : audit === null ? 'unavailable' : diff ? 'diff' : 'clean';
  const more = audit ? audit.files - audit.top.length : 0;

  return (
    <section className="space-y-3" aria-labelledby="ds-apply">
      <SectionHeader id="ds-apply" title={t('context.design.apply.title')} />
      <div className="grid grid-cols-1 border border-foreground bg-card md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3 border-b border-border p-5 md:border-b-0 md:border-r">
          <h4 className="text-lg font-semibold text-foreground">{t(`context.design.apply.${state}Title`)}</h4>
          <p className="max-w-prose text-sm text-muted-foreground">{t(`context.design.apply.${state}Body`)}</p>
          {diff && audit && (
            <ul className="border-t border-border">
              {audit.top.map((f) => (
                <li key={f.file} className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm">
                  <span className="min-w-0 truncate font-mono text-foreground" title={f.file}>{f.file}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {f.count} · {f.rules.map((r) => t(`context.design.apply.rules.${r}`)).join(', ')}
                  </span>
                </li>
              ))}
              {more > 0 && <li className="py-2 text-sm text-muted-foreground">{t('context.design.apply.more', { count: more })}</li>}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-3 p-5">
          <span className="font-mono text-xs uppercase text-muted-foreground">{t('context.design.apply.nextTitle')}</span>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
            <li>{t('context.design.apply.next1')}</li>
            <li>{t('context.design.apply.next2')}</li>
            <li>{t('context.design.apply.next3')}</li>
          </ol>
          <span className="text-xs text-muted-foreground">{t('context.design.apply.nextNote')}</span>
          <Button className="mt-auto" variant={diff ? 'default' : 'outline'} disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1.5 h-3.5 w-3.5" />}
            {t('context.design.apply.run')}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && <p className="text-sm text-foreground">{t('context.design.apply.found', { findings: result.findings, files: result.files })}</p>}
      {result && <BriefImportDialog projectId={projectId} open={open} onOpenChange={setOpen} initialText={result.brief} />}
    </section>
  );
}
