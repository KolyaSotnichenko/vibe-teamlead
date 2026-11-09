/**
 * Design system → Apply to the project: the design check QA runs on each task's new lines,
 * run over the whole UI, turned into a redesign brief the spec analyst splits into tasks.
 * The owner reads the brief and the proposed tasks before anything is created.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Wand2 } from 'lucide-react';

import type { RedesignBrief } from '../../../shared/types';
import { BriefImportDialog } from '../brief-import';
import { Button } from '../ui/button';

export function ApplyDesignSystem({ projectId }: { projectId: string }) {
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

  return (
    <section className="space-y-3" aria-labelledby="ds-apply">
      <h3 id="ds-apply" className="text-sm font-semibold text-foreground">{t('context.design.apply.title')}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.apply.body')}</p>
      <Button size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1.5 h-3.5 w-3.5" />}
        {t('context.design.apply.run')}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && <p className="text-sm text-foreground">{t('context.design.apply.found', { findings: result.findings, files: result.files })}</p>}
      {result && <BriefImportDialog projectId={projectId} open={open} onOpenChange={setOpen} initialText={result.brief} />}
    </section>
  );
}
