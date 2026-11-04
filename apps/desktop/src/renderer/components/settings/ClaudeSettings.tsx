import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { SettingsSection } from './SettingsSection';
import { ClaudeCredentialPanel } from './ClaudeCredentialPanel';
import { useClaudeCredential } from '../../hooks/useClaudeCredential';
import { cn } from '../../lib/utils';
import type { AppSettings } from '../../../shared/types';

interface ClaudeSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

type Mode = 'api' | 'subscription';

/**
 * Settings → Claude: which credential the agents run on — an API key (with an
 * optional gateway base URL) or, in personal mode, a Claude subscription token.
 * Both are kept; the mode picks one, never both.
 */
export function ClaudeSettings({ settings, onSettingsChange }: ClaudeSettingsProps) {
  const { t } = useTranslation('settings');
  const { status, setStatus } = useClaudeCredential();
  const mode: Mode = settings.useClaudeSubscription === true ? 'subscription' : 'api';

  const option = (value: Mode, label: string, hint: string, configured: boolean | undefined) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => onSettingsChange({ ...settings, useClaudeSubscription: value === 'subscription' })}
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
    <SettingsSection title={t('claude.title')} description={t('claude.description')}>
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
            <ClaudeCredentialPanel status={status} onStatusChange={setStatus} baseUrl={settings.anthropicBaseUrl ?? ''} slot="api" />

            <div className="space-y-2">
              <Label htmlFor="anthropicBaseUrl" className="text-sm font-medium text-foreground">
                {t('claude.baseUrl.label')}
              </Label>
              <Input
                id="anthropicBaseUrl"
                type="url"
                spellCheck={false}
                placeholder="https://api.anthropic.com"
                className="font-mono"
                value={settings.anthropicBaseUrl ?? ''}
                onChange={(e) => onSettingsChange({ ...settings, anthropicBaseUrl: e.target.value || undefined })}
              />
              <p className="text-sm text-muted-foreground">{t('claude.baseUrl.help')}</p>
            </div>
          </>
        ) : (
          <>
            <p className="border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">{t('claude.mode.personalNote')}</p>
            <ClaudeCredentialPanel status={status} onStatusChange={setStatus} slot="subscription" />
          </>
        )}
      </div>
    </SettingsSection>
  );
}
