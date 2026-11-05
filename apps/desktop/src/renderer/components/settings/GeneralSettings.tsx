import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import { AgentProfileSettings } from './AgentProfileSettings';
import { FeatureModelSettings } from './FeatureModelSettings';
import { ClaudeModelSelect } from './ClaudeModelSelect';
import type {
  AppSettings,
  ToolDetectionResult
} from '../../../shared/types';

interface GeneralSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  section: 'agent' | 'paths';
}

/**
 * Helper component to display auto-detected CLI tool information
 */
interface ToolDetectionDisplayProps {
  info: ToolDetectionResult | null;
  isLoading: boolean;
  t: (key: string) => string;
}

function ToolDetectionDisplay({ info, isLoading, t }: ToolDetectionDisplayProps) {
  if (isLoading) {
    return (
      <div className="text-xs text-muted-foreground mt-1">
        {t('general.detecting')}
      </div>
    );
  }

  if (!info || !info.found) {
    return (
      <div className="text-xs text-muted-foreground mt-1">
        {t('general.notDetected')}
      </div>
    );
  }

  const getSourceLabel = (source: ToolDetectionResult['source']): string => {
    const sourceMap: Record<ToolDetectionResult['source'], string> = {
      'user-config': t('general.sourceUserConfig'),
      'venv': t('general.sourceVenv'),
      'homebrew': t('general.sourceHomebrew'),
      'nvm': t('general.sourceNvm'),
      'system-path': t('general.sourceSystemPath'),
      'bundled': t('general.sourceBundled'),
      'fallback': t('general.sourceFallback'),
    };
    return sourceMap[source] || source;
  };

  return (
    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
      <div>
        <span className="font-medium">{t('general.detectedPath')}:</span>{' '}
        <code className="bg-muted px-1 py-0.5 rounded">{info.path}</code>
      </div>
      {info.version && (
        <div>
          <span className="font-medium">{t('general.detectedVersion')}:</span>{' '}
          {info.version}
        </div>
      )}
      <div>
        <span className="font-medium">{t('general.detectedSource')}:</span>{' '}
        {getSourceLabel(info.source)}
      </div>
    </div>
  );
}

/**
 * General settings component for agent configuration and paths
 */
export function GeneralSettings({ settings, onSettingsChange, section }: GeneralSettingsProps) {
  const { t } = useTranslation('settings');
  const [toolsInfo, setToolsInfo] = useState<{
    python: ToolDetectionResult;
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    glab: ToolDetectionResult;
    claude: ToolDetectionResult;
  } | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);

  // Fetch CLI tools detection info when component mounts (paths section only)
  useEffect(() => {
    if (section === 'paths') {
      setIsLoadingTools(true);
      window.electronAPI
        .getCliToolsInfo()
        .then((result: { success: boolean; data?: { python: ToolDetectionResult; git: ToolDetectionResult; gh: ToolDetectionResult; glab: ToolDetectionResult; claude: ToolDetectionResult } }) => {
          if (result.success && result.data) {
            setToolsInfo(result.data);
          }
        })
        .catch((error: unknown) => {
          console.error('Failed to fetch CLI tools info:', error);
        })
        .finally(() => {
          setIsLoadingTools(false);
        });
    }
  }, [section]);

  if (section === 'agent') {
    return (
      <div className="space-y-8">
        {/* Agent profiles (per-phase Claude models and thinking) and feature models */}
        <SettingsSection
          title={t('agentProfile.title')}
          description={t('agentProfile.sectionDescription')}
        >
          <div className="space-y-8">
            <AgentProfileSettings />
            <FeatureModelSettings />
          </div>
        </SettingsSection>

        {/* Helper subagents for the planner, coder and QA */}
        <SettingsSection title={t('subagents.title')} description={t('subagents.description')}>
          <div className="max-w-md space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="subagentsEnabled" className="text-sm font-medium text-foreground">{t('subagents.enable')}</Label>
                <p className="text-xs text-muted-foreground">{t('subagents.enableHint')}</p>
              </div>
              <Switch
                id="subagentsEnabled"
                checked={settings.subagentsEnabled !== false}
                onCheckedChange={(checked) => onSettingsChange({ ...settings, subagentsEnabled: checked })}
              />
            </div>
            {settings.subagentsEnabled !== false && (
              <div className="space-y-1.5">
                <div className="flex h-5 items-center justify-between">
                  <Label htmlFor="subagentModel" className="text-xs text-muted-foreground">{t('subagents.model')}</Label>
                  {settings.subagentModel && (
                    <button
                      type="button"
                      className="text-xs text-foreground underline-offset-4 hover:underline"
                      onClick={() => onSettingsChange({ ...settings, subagentModel: '' })}
                    >
                      {t('subagents.sameModel')}
                    </button>
                  )}
                </div>
                <ClaudeModelSelect
                  id="subagentModel"
                  value={settings.subagentModel ?? ''}
                  onChange={(value) => onSettingsChange({ ...settings, subagentModel: value })}
                  placeholder={t('subagents.sameModelPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('subagents.modelHint')}</p>
              </div>
            )}
          </div>
        </SettingsSection>

        {/* Other Agent Settings */}
        <SettingsSection
          title={t('general.otherAgentSettings')}
          description={t('general.otherAgentSettingsDescription')}
        >
          <div className="space-y-6">
            <div className="space-y-3">
              <Label htmlFor="agentFramework" className="text-sm font-medium text-foreground">{t('general.agentFramework')}</Label>
              <p className="text-sm text-muted-foreground">{t('general.agentFrameworkDescription')}</p>
              <Select
                value={settings.agentFramework === 'auto-claude' ? 'vibe-teamlead' : settings.agentFramework}
                onValueChange={(value) => onSettingsChange({ ...settings, agentFramework: value })}
              >
                <SelectTrigger id="agentFramework" className="w-full max-w-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vibe-teamlead">{t('general.agentFrameworkVibeTeamlead')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between max-w-md">
                <div className="space-y-1">
                  <Label htmlFor="autoNameTerminals" className="text-sm font-medium text-foreground">
                    {t('general.aiTerminalNaming')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('general.aiTerminalNamingDescription')}
                  </p>
                </div>
                <Switch
                  id="autoNameTerminals"
                  checked={settings.autoNameTerminals}
                  onCheckedChange={(checked) => onSettingsChange({ ...settings, autoNameTerminals: checked })}
                />
              </div>
              <div className="space-y-1 max-w-md">
                <Label htmlFor="architectMode" className="text-sm font-medium text-foreground">
                  {t('general.architect')}
                </Label>
                <p className="text-sm text-muted-foreground">{t('general.architectDescription')}</p>
                <Select
                  value={settings.architectMode ?? 'complex'}
                  onValueChange={(value) => onSettingsChange({ ...settings, architectMode: value as AppSettings['architectMode'] })}
                >
                  <SelectTrigger id="architectMode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['always', 'complex', 'never'] as const).map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`general.architectMode.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t(`general.architectModeHint.${settings.architectMode ?? 'complex'}`)}</p>
              </div>
              <div className="flex items-center justify-between max-w-md">
                <div className="space-y-1">
                  <Label htmlFor="securityQaEnabled" className="text-sm font-medium text-foreground">
                    {t('general.securityQa')}
                  </Label>
                  <p className="text-sm text-muted-foreground">{t('general.securityQaDescription')}</p>
                </div>
                <Switch
                  id="securityQaEnabled"
                  checked={settings.securityQaEnabled === true}
                  onCheckedChange={(checked) => onSettingsChange({ ...settings, securityQaEnabled: checked })}
                />
              </div>
              {settings.securityQaEnabled === true && (
                <div className="grid max-w-md grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('general.securityQaScanMode')}</Label>
                    <Select
                      value={settings.securityQaScanMode ?? 'quick'}
                      onValueChange={(value) =>
                        onSettingsChange({ ...settings, securityQaScanMode: value as AppSettings['securityQaScanMode'] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['quick', 'standard', 'deep'] as const).map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {t(`general.securityQaMode.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('general.securityQaFailOn')}</Label>
                    <Select
                      value={settings.securityQaFailOn ?? 'high'}
                      onValueChange={(value) =>
                        onSettingsChange({ ...settings, securityQaFailOn: value as AppSettings['securityQaFailOn'] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['critical', 'high', 'medium', 'low'] as const).map((severity) => (
                          <SelectItem key={severity} value={severity}>
                            {t(`general.securityQaSeverity.${severity}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="securityQaMaxBudgetUsd" className="text-xs text-muted-foreground">
                      {t('general.securityQaBudget')}
                    </Label>
                    <Input
                      id="securityQaMaxBudgetUsd"
                      type="number"
                      min={1}
                      step={1}
                      value={settings.securityQaMaxBudgetUsd ?? 5}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (value > 0) onSettingsChange({ ...settings, securityQaMaxBudgetUsd: value });
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </SettingsSection>
      </div>
    );
  }

  // paths section
  return (
    <SettingsSection
      title={t('general.paths')}
      description={t('general.pathsDescription')}
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <Label htmlFor="pythonPath" className="text-sm font-medium text-foreground">{t('general.pythonPath')}</Label>
          <p className="text-sm text-muted-foreground">{t('general.pythonPathDescription')}</p>
          <Input
            id="pythonPath"
            placeholder={t('general.pythonPathPlaceholder')}
            className="w-full max-w-lg"
            value={settings.pythonPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, pythonPath: e.target.value })}
          />
          {!settings.pythonPath && (
            <ToolDetectionDisplay
              info={toolsInfo?.python || null}
              isLoading={isLoadingTools}
              t={t}
            />
          )}
        </div>
        <div className="space-y-3">
          <Label htmlFor="gitPath" className="text-sm font-medium text-foreground">{t('general.gitPath')}</Label>
          <p className="text-sm text-muted-foreground">{t('general.gitPathDescription')}</p>
          <Input
            id="gitPath"
            placeholder={t('general.gitPathPlaceholder')}
            className="w-full max-w-lg"
            value={settings.gitPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, gitPath: e.target.value })}
          />
          {!settings.gitPath && (
            <ToolDetectionDisplay
              info={toolsInfo?.git || null}
              isLoading={isLoadingTools}
              t={t}
            />
          )}
        </div>
        <div className="space-y-3">
          <Label htmlFor="githubCLIPath" className="text-sm font-medium text-foreground">{t('general.githubCLIPath')}</Label>
          <p className="text-sm text-muted-foreground">{t('general.githubCLIPathDescription')}</p>
          <Input
            id="githubCLIPath"
            placeholder={t('general.githubCLIPathPlaceholder')}
            className="w-full max-w-lg"
            value={settings.githubCLIPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, githubCLIPath: e.target.value })}
          />
          {!settings.githubCLIPath && (
            <ToolDetectionDisplay
              info={toolsInfo?.gh || null}
              isLoading={isLoadingTools}
              t={t}
            />
          )}
        </div>
        <div className="space-y-3">
          <Label htmlFor="gitlabCLIPath" className="text-sm font-medium text-foreground">{t('general.gitlabCLIPath')}</Label>
          <p className="text-sm text-muted-foreground">{t('general.gitlabCLIPathDescription')}</p>
          <Input
            id="gitlabCLIPath"
            placeholder={t('general.gitlabCLIPathPlaceholder')}
            className="w-full max-w-lg"
            value={settings.gitlabCLIPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, gitlabCLIPath: e.target.value })}
          />
          {!settings.gitlabCLIPath && (
            <ToolDetectionDisplay
              info={toolsInfo?.glab || null}
              isLoading={isLoadingTools}
              t={t}
            />
          )}
        </div>
        <div className="space-y-3">
          <Label htmlFor="claudePath" className="text-sm font-medium text-foreground">{t('general.claudePath')}</Label>
          <p className="text-sm text-muted-foreground">{t('general.claudePathDescription')}</p>
          <Input
            id="claudePath"
            placeholder={t('general.claudePathPlaceholder')}
            className="w-full max-w-lg"
            value={settings.claudePath || ''}
            onChange={(e) => onSettingsChange({ ...settings, claudePath: e.target.value })}
          />
          {!settings.claudePath && (
            <ToolDetectionDisplay
              info={toolsInfo?.claude || null}
              isLoading={isLoadingTools}
              t={t}
            />
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
