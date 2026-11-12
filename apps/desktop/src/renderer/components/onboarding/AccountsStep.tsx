import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Github } from 'lucide-react';
import { Button } from '../ui/button';
import { VercelPanel } from '../settings/VercelPanel';
import { GitHubOAuthFlow } from '../project-settings/GitHubOAuthFlow';

interface AccountsStepProps {
  onNext: () => void;
  onBack: () => void;
}

/**
 * Optional Accounts step of the onboarding wizard.
 *
 * Signs in to GitHub (and optionally Vercel) with the same device flow the setup modal uses
 * (GitHubOAuthFlow). It only signs in; anything skipped can be connected
 * later in the project's settings.
 */
export function AccountsStep({ onNext, onBack }: AccountsStepProps) {
  const { t } = useTranslation(['onboarding', 'dialogs']);
  const [connected, setConnected] = useState(false);
  const [login, setLogin] = useState<string | undefined>();
  const [vercelConnected, setVercelConnected] = useState(false);

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-6">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Github aria-hidden="true" className="h-7 w-7" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {t('onboarding:accounts.title')}
          </h1>
          <p className="mt-2 text-muted-foreground">{t('onboarding:accounts.purpose')}</p>
        </div>

        {connected ? (
          <div role="status" className="flex items-center justify-center gap-3 border border-foreground p-5 text-sm text-foreground">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
            {login
              ? t('onboarding:accounts.connectedAs', { login })
              : t('onboarding:accounts.connected')}
          </div>
        ) : (
          <GitHubOAuthFlow
            onSuccess={(_token, username) => {
              setLogin(username);
              setConnected(true);
            }}
          />
        )}

        <section className="mt-8 space-y-3 border-t border-border pt-6">
          <h2 className="text-lg font-semibold text-foreground">{t('onboarding:accounts.vercelTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('onboarding:accounts.vercelPurpose')}</p>
          <VercelPanel onStatusChange={setVercelConnected} />
        </section>

        <p className="mt-6 text-center text-sm text-muted-foreground">{t('onboarding:accounts.later')}</p>

        <div className="sticky bottom-0 z-10 mt-10 flex justify-between items-center border-t border-border bg-card py-4">
          <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
            {t('onboarding:accounts.back')}
          </Button>
          {connected || vercelConnected ? (
            <Button onClick={onNext}>{t('onboarding:accounts.continue')}</Button>
          ) : (
            <Button variant="outline" onClick={onNext}>
              {t('onboarding:accounts.skip')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
