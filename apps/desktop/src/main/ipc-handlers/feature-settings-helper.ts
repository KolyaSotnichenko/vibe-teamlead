/**
 * Feature Settings Helper
 *
 * Reads feature settings (Claude model + thinking level) for feature runners
 * like Insights, Ideation, Roadmap and naming.
 *
 * Resolution order:
 * 1. settings.featureModels[featureKey] / settings.featureThinking[featureKey]
 * 2. DEFAULT_FEATURE_MODELS[featureKey] / DEFAULT_FEATURE_THINKING[featureKey]
 *
 * A stored model of a removed (non-Claude) provider falls back to the default.
 */

import { isUsableModel } from '../ai/config/phase-config';
import { readSettingsFile } from '../settings-utils';
import { DEFAULT_FEATURE_MODELS, DEFAULT_FEATURE_THINKING } from '../../shared/constants/models';
import type { FeatureModelConfig, FeatureThinkingConfig } from '../../shared/types/settings';

type FeatureKey = keyof FeatureModelConfig;

interface FeatureSettings {
  model: string;
  thinkingLevel: string;
}

/** Feature model and thinking level for a specific feature runner. */
export function getFeatureSettings(featureKey: FeatureKey): FeatureSettings {
  const settings = readSettingsFile();
  const models = settings?.featureModels as FeatureModelConfig | undefined;
  const thinking = settings?.featureThinking as FeatureThinkingConfig | undefined;
  const model = models?.[featureKey];
  return {
    model: isUsableModel(model) ? model : DEFAULT_FEATURE_MODELS[featureKey],
    thinkingLevel: thinking?.[featureKey] ?? DEFAULT_FEATURE_THINKING[featureKey],
  };
}
