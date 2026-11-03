/**
 * Translated names for the built-in agent profiles, thinking levels and
 * feature model settings. The constants in shared/constants/models.ts keep
 * English names as the fallback (e.g. for profiles that have no translation).
 */
import type { TFunction } from 'i18next';
import { FEATURE_LABELS, THINKING_LEVELS } from '../../shared/constants';
import type { FeatureModelConfig } from '../../shared/types/settings';

interface ProfileLike {
  id: string;
  name: string;
  description?: string;
}

export function profileName(t: TFunction, profile: ProfileLike): string {
  return t(`settings:agentProfile.profiles.${profile.id}.name`, { defaultValue: profile.name });
}

export function profileDescription(t: TFunction, profile: ProfileLike): string {
  return t(`settings:agentProfile.profiles.${profile.id}.description`, { defaultValue: profile.description ?? '' });
}

function englishLevel(value: string) {
  return THINKING_LEVELS.find((l) => l.value === value);
}

/** "Low", "High"… */
export function thinkingLabel(t: TFunction, value: string): string {
  return t(`settings:thinkingLevels.${value}.label`, { defaultValue: englishLevel(value)?.label ?? value });
}

export function thinkingDescription(t: TFunction, value: string): string {
  return t(`settings:thinkingLevels.${value}.description`, { defaultValue: englishLevel(value)?.description ?? '' });
}

/** Badge text: "High thinking" */
export function thinkingBadge(t: TFunction, value: string): string {
  return t(`settings:thinkingLevels.${value}.badge`, { defaultValue: `${englishLevel(value)?.label ?? value} thinking` });
}

export function featureLabel(t: TFunction, feature: keyof FeatureModelConfig): string {
  return t(`settings:featureModels.${feature}.label`, { defaultValue: FEATURE_LABELS[feature].label });
}

export function featureDescription(t: TFunction, feature: keyof FeatureModelConfig): string {
  return t(`settings:featureModels.${feature}.description`, { defaultValue: FEATURE_LABELS[feature].description });
}
