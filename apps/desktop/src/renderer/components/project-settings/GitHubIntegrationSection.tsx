import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Github, RefreshCw, KeyRound, Info, CheckCircle2 } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import { StatusBadge } from './StatusBadge';
import { PasswordInput } from './PasswordInput';
import { ConnectionStatus } from './ConnectionStatus';
import { GitHubOAuthFlow } from './GitHubOAuthFlow';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Separator } from '../ui/separator';
import { Button } from '../ui/button';
import type { ProjectEnvConfig, GitHubSyncStatus } from '../../../shared/types';

interface GitHubIntegrationSectionProps {
  isExpanded: boolean;
  onToggle: () => void;
  envConfig: ProjectEnvConfig;
  onUpdateConfig: (updates: Partial<ProjectEnvConfig>) => void;
  gitHubConnectionStatus: GitHubSyncStatus | null;
  isCheckingGitHub: boolean;
  projectName?: string;
}

export function GitHubIntegrationSection({
  isExpanded,
  onToggle,
  envConfig,
  onUpdateConfig,
  gitHubConnectionStatus,
  isCheckingGitHub,
  projectName,
}: GitHubIntegrationSectionProps) {
  const { t } = useTranslation('settings');
  // Show OAuth flow if user previously used OAuth, or if there's no token yet
  const [showOAuthFlow, setShowOAuthFlow] = useState(
    envConfig.githubAuthMethod === 'oauth' || (!envConfig.githubToken && !envConfig.githubAuthMethod)
  );

  const badge = envConfig.githubEnabled ? (
    <StatusBadge status="success" label={t('settings:integrations.common.enabled')} />
  ) : null;

  const handleOAuthSuccess = (token: string, _username?: string) => {
    onUpdateConfig({ githubToken: token, githubAuthMethod: 'oauth' });
    setShowOAuthFlow(false);
  };

  const handleManualTokenChange = (value: string) => {
    onUpdateConfig({ githubToken: value, githubAuthMethod: 'pat' });
  };

  return (
    <CollapsibleSection
      title={t('settings:integrations.github.title')}
      icon={<Github className="h-4 w-4" />}
      isExpanded={isExpanded}
      onToggle={onToggle}
      badge={badge}
    >
      {/* Project-Specific Configuration Notice */}
      {projectName && (
        <div className="rounded-lg border border-info/30 bg-info/5 p-3 mb-4">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-info mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">{t('settings:integrations.github.projectSpecificTitle')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                <Trans
                  i18nKey="settings:integrations.github.projectSpecificDescription"
                  values={{ projectName }}
                  components={{ strong: <span className="font-semibold text-foreground" /> }}
                />
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">{t('settings:integrations.github.enableIssues')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings:integrations.github.enableIssuesDescription')}
          </p>
        </div>
        <Switch
          checked={envConfig.githubEnabled}
          onCheckedChange={(checked) => onUpdateConfig({ githubEnabled: checked })}
        />
      </div>

      {envConfig.githubEnabled && (
        <>
          {/* Show OAuth connected state when authenticated via OAuth */}
          {envConfig.githubAuthMethod === 'oauth' && envConfig.githubToken && !showOAuthFlow ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium text-foreground">{t('settings:integrations.github.authentication')}</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onUpdateConfig({ githubToken: '', githubAuthMethod: undefined })}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t('settings:integrations.github.useManualToken')}
                </Button>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg border border-success/30 bg-success/5">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <span className="text-sm text-foreground">{t('settings:integrations.github.authenticatedViaOAuth')}</span>
              </div>
            </div>
          ) : showOAuthFlow ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium text-foreground">{t('settings:integrations.github.authentication')}</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowOAuthFlow(false)}
                >
                  {t('settings:integrations.github.useManualToken')}
                </Button>
              </div>
              <GitHubOAuthFlow
                onSuccess={handleOAuthSuccess}
                onCancel={() => setShowOAuthFlow(false)}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium text-foreground">{t('settings:integrations.github.personalAccessToken')}</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowOAuthFlow(true)}
                  className="gap-2"
                >
                  <KeyRound className="h-3 w-3" />
                  {t('settings:integrations.github.useOAuthInstead')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                <Trans
                  i18nKey="settings:integrations.github.tokenHint"
                  components={{
                    code: <code className="px-1 bg-muted rounded" />,
                    link: (
                      // biome-ignore lint/a11y/useAnchorContent: Trans injects the link text
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo&description=Auto-Build-UI"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info hover:underline"
                      />
                    ),
                  }}
                />
              </p>
              <PasswordInput
                value={envConfig.githubToken || ''}
                onChange={handleManualTokenChange}
                placeholder={t('settings:integrations.github.tokenPlaceholder')}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('settings:integrations.github.repository')}</Label>
            <p className="text-xs text-muted-foreground">
              <Trans
                i18nKey="settings:integrations.github.repoFormat"
                components={{ code: <code className="px-1 bg-muted rounded" /> }}
              />
            </p>
            <Input
              placeholder={t('settings:integrations.github.repoPlaceholder')}
              value={envConfig.githubRepo || ''}
              onChange={(e) => onUpdateConfig({ githubRepo: e.target.value })}
            />
          </div>

          {/* Connection Status */}
          {envConfig.githubToken && envConfig.githubRepo && (
            <ConnectionStatus
              isChecking={isCheckingGitHub}
              isConnected={gitHubConnectionStatus?.connected || false}
              title={t('settings:integrations.common.connectionStatus')}
              successMessage={t('settings:integrations.github.connectedTo', { repo: gitHubConnectionStatus?.repoFullName })}
              errorMessage={gitHubConnectionStatus?.error || t('settings:integrations.common.notConnected')}
              additionalInfo={gitHubConnectionStatus?.repoDescription}
            />
          )}

          {/* Info about accessing issues */}
          {gitHubConnectionStatus?.connected && (
            <div className="rounded-lg border border-info/30 bg-info/5 p-3">
              <div className="flex items-start gap-3">
                <Github className="h-5 w-5 text-info mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{t('settings:integrations.github.issuesAvailable')}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('settings:integrations.github.issuesAvailableDescription')}
                  </p>
                </div>
              </div>
            </div>
          )}

          <Separator />

          {/* Auto-sync Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-info" />
                <Label className="font-normal text-foreground">{t('settings:integrations.github.autoSync')}</Label>
              </div>
              <p className="text-xs text-muted-foreground pl-6">
                {t('settings:integrations.github.autoSyncDescription')}
              </p>
            </div>
            <Switch
              checked={envConfig.githubAutoSync || false}
              onCheckedChange={(checked) => onUpdateConfig({ githubAutoSync: checked })}
            />
          </div>
        </>
      )}
    </CollapsibleSection>
  );
}
