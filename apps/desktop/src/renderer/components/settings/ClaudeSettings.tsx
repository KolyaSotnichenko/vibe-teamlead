import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { SettingsSection } from './SettingsSection';
import { ClaudeCredentialChooser } from './ClaudeCredentialChooser';
import { useClaudeCredential } from '../../hooks/useClaudeCredential';
import type { AppSettings } from '../../../shared/types';

interface ClaudeSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Settings → Claude: which credential the agents run on — an API key (with an
 * optional gateway base URL) or, in personal mode, a Claude subscription token.
 * Both are kept; the mode picks one, never both.
 */
export function ClaudeSettings({ settings, onSettingsChange }: ClaudeSettingsProps) {
  const { t } = useTranslation('settings');
  const { status, setStatus } = useClaudeCredential();

  return (
    <SettingsSection title={t('claude.title')} description={t('claude.description')}>
      <ClaudeCredentialChooser
        subscription={settings.useClaudeSubscription === true}
        onModeChange={(useClaudeSubscription) => onSettingsChange({ ...settings, useClaudeSubscription })}
        status={status}
        onStatusChange={setStatus}
        baseUrl={settings.anthropicBaseUrl ?? ''}
        apiExtra={
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
        }
      />
    </SettingsSection>
  );
}
