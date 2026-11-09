import { useTranslation } from 'react-i18next';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { ClaudeModelSelect } from './ClaudeModelSelect';
import { ThinkingLevelSelect } from './ThinkingLevelSelect';
import { Label } from '../ui/label';
import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_THINKING,
  FEATURE_LABELS,
} from '@shared/constants/models';
import type { FeatureModelConfig, FeatureThinkingConfig, ThinkingLevel } from '@shared/types/settings';
import { featureDescription, featureLabel } from '../../lib/agent-labels';

/**
 * Feature model configuration component.
 *
 * Renders a Claude model selector and a thinking-level selector for each
 * feature (Insights, Ideation, Roadmap, GitHub Issues, GitHub PRs, Utility, Naming).
 *
 * Reads `settings.featureModels` / `settings.featureThinking` with fallback
 * to the defaults; writes via `saveSettings`.
 */
export function FeatureModelSettings() {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((state) => state.settings);

  // Saved choices over the defaults; spec import reads the roadmap choice until set
  // (same rule as main's getFeatureSettings), so older settings show what will run.
  const savedModels = settings.featureModels as Partial<FeatureModelConfig> | undefined;
  const savedThinking = settings.featureThinking as Partial<FeatureThinkingConfig> | undefined;
  const featureModels: FeatureModelConfig = {
    ...DEFAULT_FEATURE_MODELS,
    ...savedModels,
    briefImport: savedModels?.briefImport ?? savedModels?.roadmap ?? DEFAULT_FEATURE_MODELS.briefImport,
    designSystem: savedModels?.designSystem ?? savedModels?.roadmap ?? DEFAULT_FEATURE_MODELS.designSystem,
    uxReview: savedModels?.uxReview ?? savedModels?.designSystem ?? savedModels?.roadmap ?? DEFAULT_FEATURE_MODELS.uxReview,
  };
  const featureThinking: FeatureThinkingConfig = {
    ...DEFAULT_FEATURE_THINKING,
    ...savedThinking,
    briefImport: savedThinking?.briefImport ?? savedThinking?.roadmap ?? DEFAULT_FEATURE_THINKING.briefImport,
    designSystem: savedThinking?.designSystem ?? savedThinking?.roadmap ?? DEFAULT_FEATURE_THINKING.designSystem,
    uxReview: savedThinking?.uxReview ?? savedThinking?.designSystem ?? savedThinking?.roadmap ?? DEFAULT_FEATURE_THINKING.uxReview,
  };

  const handleModelChange = (feature: keyof FeatureModelConfig, value: string) => {
    saveSettings({ featureModels: { ...featureModels, [feature]: value } });
  };

  const handleThinkingChange = (feature: keyof FeatureModelConfig, value: string) => {
    saveSettings({ featureThinking: { ...featureThinking, [feature]: value as ThinkingLevel } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm font-medium text-foreground">
          {t('general.featureModelSettings')}
        </Label>
      </div>

      {(Object.keys(FEATURE_LABELS) as Array<keyof FeatureModelConfig>).map((feature) => {
        const currentModel = featureModels[feature];
        const currentThinking = featureThinking[feature];

        return (
          <div key={feature} className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium text-foreground">
                {featureLabel(t, feature)}
              </Label>
              <span className="text-xs text-muted-foreground">
                {featureDescription(t, feature)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              {/* Model Select */}
              <div className="space-y-1">
                <Label className="flex h-5 items-center text-xs text-muted-foreground">
                  {t('general.model')}
                </Label>
                <ClaudeModelSelect
                  value={currentModel}
                  onChange={(value) => handleModelChange(feature, value)}
                />
              </div>

              {/* Thinking Level Select */}
              <ThinkingLevelSelect
                value={currentThinking}
                onChange={(value) => handleThinkingChange(feature, value)}
                modelValue={currentModel}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
