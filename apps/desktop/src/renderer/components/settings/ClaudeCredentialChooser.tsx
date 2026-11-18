/**
 * Which Claude credential the agents run on — an API key (the default) or, in personal
 * mode, a Claude subscription token — and the panel for the chosen one.
 *
 * The same in every place that asks for it: Settings → Claude, the onboarding wizard
 * and the GitHub setup dialog. Picking a mode is saved at once.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { ClaudeCredentialPanel } from './ClaudeCredentialPanel';
import { saveSettings } from '../../stores/settings-store';
import { cn } from '../../lib/utils';
import { openClaudeSetupToken } from '../../lib/open-terminal';
import type { ClaudeCredentialStatus } from '../../../shared/types';

type Mode = 'api' | 'subscription';

interface ClaudeCredentialChooserProps {
  /** The saved mode: `settings.useClaudeSubscription === true` */
  subscription: boolean;
  /** Called after a pick, besides saving it (Settings keeps its form state in step) */
  onModeChange?: (useClaudeSubscription: boolean) => void;
  status: ClaudeCredentialStatus;
  onStatusChange: (status: ClaudeCredentialStatus) => void;
  /** Base URL to test the API key with (the unsaved value from the form, if any) */
  baseUrl?: string;
  /** Shown under the API key panel in API mode (Settings: the base URL field) */
  apiExtra?: ReactNode;
}

/** Whether the credential the mode uses is there (older main processes report only the active one). */
export function isModeConfigured(status: ClaudeCredentialStatus, subscription: boolean): boolean {
  return ((subscription ? status.subscription : status.api) ?? status).configured;
}

export function ClaudeCredentialChooser({
  subscription,
  onModeChange,
  status,
  onStatusChange,
  baseUrl,
  apiExtra,
}: ClaudeCredentialChooserProps) {
  const { t } = useTranslation('settings');
  const mode: Mode = subscription ? 'subscription' : 'api';

  const option = (value: Mode, label: string, hint: string, configured: boolean | undefined) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => {
        const useClaudeSubscription = value === 'subscription';
        onModeChange?.(useClaudeSubscription);
        // Saved at once, like the key and the connection test beside it: waiting for a
        // Save left sessions in the other mode while the test passed
        void saveSettings({ useClaudeSubscription });
      }}
      className={cn(
        'flex min-h-11 flex-1 flex-col items-start gap-1 border px-4 py-3 text-left transition-colors',
        mode === value ? 'border-foreground bg-foreground text-background' : 'border-border text-foreground hover:bg-accent'
      )}
    >
      <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
        {label}
        <span className={cn('font-mono text-[11px]', mode === value ? 'text-background/70' : 'text-muted-foreground')}>
          {configured ? '●' : '○'}
        </span>
      </span>
      <span className={cn('text-xs', mode === value ? 'text-background/80' : 'text-muted-foreground')}>{hint}</span>
    </button>
  );

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Label className="text-sm font-medium text-foreground">{t('claude.mode.label')}</Label>
        <div role="radiogroup" aria-label={t('claude.mode.label')} className="flex gap-2">
          {option('api', t('claude.mode.api'), t('claude.mode.apiHint'), (status.api ?? status).configured && status.api?.kind !== 'subscription-token')}
          {option('subscription', t('claude.mode.subscription'), t('claude.mode.subscriptionHint'), status.subscription?.configured)}
        </div>
        <p className="text-xs text-muted-foreground">{t('claude.mode.savedHint')}</p>
      </div>

      {mode === 'api' ? (
        <>
          <ClaudeCredentialPanel status={status} onStatusChange={onStatusChange} baseUrl={baseUrl} slot="api" />
          {apiExtra}
        </>
      ) : (
        <>
          <p className="border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">{t('claude.mode.personalNote')}</p>
          {/* The bundled Claude Code prints the token in the app's terminal; the owner pastes it below */}
          <div className="space-y-2">
            <Button type="button" variant="outline" onClick={openClaudeSetupToken}>
              {t('claude.setupToken.button')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('claude.setupToken.help')}</p>
          </div>
          <ClaudeCredentialPanel status={status} onStatusChange={onStatusChange} slot="subscription" />
        </>
      )}
    </div>
  );
}
