import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Separator } from '../ui/separator';
import { SettingsSection } from './SettingsSection';
import { ClaudeCredentialPanel } from './ClaudeCredentialPanel';
import { useClaudeCredential } from '../../hooks/useClaudeCredential';
import type { AppSettings } from '../../../shared/types';

interface ClaudeSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Settings → Claude: the one credential every agent and utility task runs on,
 * an optional gateway base URL, and personal (subscription) mode.
 */
export function ClaudeSettings({ settings, onSettingsChange }: ClaudeSettingsProps) {
  const { t } = useTranslation('settings');
  const { status, setStatus } = useClaudeCredential();

  return (
    <SettingsSection title={t('claude.title')} description={t('claude.description')}>
      <div className="space-y-8">
        <ClaudeCredentialPanel
          status={status}
          onStatusChange={setStatus}
          baseUrl={settings.anthropicBaseUrl ?? ''}
        />

        {status.kind === 'subscription-token' && settings.useClaudeSubscription !== true && (
          <p role="status" className="border-l-2 border-warning bg-muted px-3 py-2 text-sm text-foreground">
            {t('claude.personalMode.tokenNeedsMode')}
          </p>
        )}

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

        <Separator />

        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <Label htmlFor="useClaudeSubscription" className="text-sm font-medium text-foreground">
              {t('claude.personalMode.label')}
            </Label>
            <p className="text-sm text-muted-foreground">{t('claude.personalMode.description')}</p>
          </div>
          <Switch
            id="useClaudeSubscription"
            checked={settings.useClaudeSubscription === true}
            onCheckedChange={(checked) => onSettingsChange({ ...settings, useClaudeSubscription: checked })}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
