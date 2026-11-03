import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { Button } from '../ui/button';
import { ClaudeCredentialPanel } from '../settings/ClaudeCredentialPanel';
import { useClaudeCredential } from '../../hooks/useClaudeCredential';

interface ClaudeStepProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

/**
 * Onboarding step: connect Claude. Every agent runs on one Anthropic API key,
 * saved the same way as in Settings → Claude.
 */
export function ClaudeStep({ onNext, onBack, onSkip }: ClaudeStepProps) {
  const { t } = useTranslation('onboarding');
  const { status, setStatus } = useClaudeCredential();

  return (
    <div className="flex h-full flex-col items-center px-8 py-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center border border-foreground text-foreground">
              <KeyRound className="h-7 w-7" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('claude.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('claude.description')}</p>
        </div>

        <div className="border border-border bg-card p-5">
          <ClaudeCredentialPanel status={status} onStatusChange={setStatus} />
        </div>

        <div className="mt-6 space-y-2 border-l-2 border-foreground bg-muted px-4 py-3 text-sm text-muted-foreground">
          <p>{t('claude.whereToGetKey')}</p>
          <p>{t('claude.personalMode')}</p>
        </div>

        <div className="sticky bottom-0 z-10 mt-10 flex items-center justify-between border-t border-border bg-card py-4">
          <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
            {t('claude.buttons.back')}
          </Button>
          <div className="flex gap-4">
            <Button variant="ghost" onClick={onSkip} className="text-muted-foreground hover:text-foreground">
              {t('claude.buttons.skip')}
            </Button>
            <Button onClick={onNext} disabled={!status.configured}>
              {t('claude.buttons.continue')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
