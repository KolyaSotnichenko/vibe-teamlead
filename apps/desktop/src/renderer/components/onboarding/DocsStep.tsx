import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookMarked } from 'lucide-react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import {
  FullScreenDialog,
  FullScreenDialogContent,
  FullScreenDialogTitle,
} from '../ui/full-screen-dialog';
import { DocsView } from '../docs/DocsView';

interface DocsStepProps {
  onNext: () => void;
  onBack: () => void;
}

const COVERS = ['pipeline', 'agents', 'preview', 'settings', 'costs'] as const;

/**
 * Onboarding step: read the documentation before starting work. It says what the docs
 * cover, opens them over the wizard (its progress stays), and goes on only once the
 * user confirms they have read them or will.
 */
export function DocsStep({ onNext, onBack }: DocsStepProps) {
  const { t } = useTranslation('onboarding');
  const [acknowledged, setAcknowledged] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);

  return (
    <div className="flex h-full flex-col items-center px-8 py-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center border border-foreground text-foreground">
              <BookMarked aria-hidden="true" className="h-7 w-7" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('docs.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('docs.required')}</p>
        </div>

        <div className="border border-border bg-card p-5">
          <p className="text-sm font-medium text-foreground">{t('docs.coversLabel')}</p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {COVERS.map((item) => (
              <li key={item} className="border-l-2 border-border pl-3">
                {t(`docs.covers.${item}`)}
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" className="mt-5" onClick={() => setDocsOpen(true)}>
            <BookMarked aria-hidden="true" className="mr-2 h-4 w-4" />
            {t('docs.open')}
          </Button>
        </div>

        <div className="mt-6 flex items-start gap-3 border-l-2 border-foreground bg-muted px-4 py-3">
          <Checkbox
            id="onboarding-docs-ack"
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
            className="mt-0.5"
          />
          <Label htmlFor="onboarding-docs-ack" className="text-sm font-medium text-foreground">
            {t('docs.acknowledge')}
          </Label>
        </div>

        <div className="sticky bottom-0 z-10 mt-10 flex items-center justify-between border-t border-border bg-card py-4">
          <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
            {t('docs.back')}
          </Button>
          <Button onClick={onNext} disabled={!acknowledged}>
            {t('docs.continue')}
          </Button>
        </div>
      </div>

      {/* The Documentation page over the wizard; closing it returns to this step */}
      <FullScreenDialog open={docsOpen} onOpenChange={setDocsOpen}>
        <FullScreenDialogContent>
          <FullScreenDialogTitle className="sr-only">{t('docs.title')}</FullScreenDialogTitle>
          <div className="min-h-0 flex-1">
            <DocsView />
          </div>
        </FullScreenDialogContent>
      </FullScreenDialog>
    </div>
  );
}
