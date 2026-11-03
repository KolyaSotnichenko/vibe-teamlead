import { useTranslation } from 'react-i18next';
import { Wrench } from 'lucide-react';
import { Button } from '../ui/button';
import { ToolsChecklist } from '../tools-check';

interface ToolsStepProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

/**
 * Onboarding step: which optional tools this Mac has (security gates, browser QA,
 * Security QA). Nothing here is required, so Continue and Skip are always enabled.
 */
export function ToolsStep({ onNext, onBack, onSkip }: ToolsStepProps) {
  const { t } = useTranslation('onboarding');

  return (
    <div className="flex h-full flex-col items-center px-8 py-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center border border-foreground text-foreground">
              <Wrench className="h-7 w-7" aria-hidden="true" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('tools.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('tools.description')}</p>
        </div>

        <ToolsChecklist />

        <div className="sticky bottom-0 z-10 mt-10 flex items-center justify-between border-t border-border bg-card py-4">
          <Button variant="ghost" onClick={onBack} className="min-h-11 text-muted-foreground hover:text-foreground">
            {t('tools.buttons.back')}
          </Button>
          <div className="flex gap-4">
            <Button variant="ghost" onClick={onSkip} className="min-h-11 text-muted-foreground hover:text-foreground">
              {t('tools.buttons.skip')}
            </Button>
            <Button onClick={onNext} className="min-h-11">
              {t('tools.buttons.continue')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
