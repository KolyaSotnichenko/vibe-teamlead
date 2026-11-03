/**
 * Agent Settings Resolution Hook
 *
 * Resolves Claude model and thinking settings for agents from the selected
 * agent profile and the user's custom overrides.
 *
 * Resolution order for phase settings:
 * 1. Custom phase overrides (customPhaseModels / customPhaseThinking)
 * 2. Selected agent profile's phase configuration
 * 3. Default phase configuration
 *
 * Feature settings: featureModels / featureThinking, then defaults.
 */

import { useMemo } from 'react';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_THINKING,
} from '../../shared/constants/models';
import type {
  AppSettings,
  PhaseModelConfig,
  PhaseThinkingConfig,
  FeatureModelConfig,
  FeatureThinkingConfig,
  ThinkingLevel,
} from '../../shared/types/settings';

/**
 * Resolved agent settings configuration
 * Contains all the resolved model and thinking settings for agents
 */
export interface ResolvedAgentSettings {
  /** Phase model settings (spec, planning, coding, qa) */
  phaseModels: PhaseModelConfig;
  /** Phase thinking level settings */
  phaseThinking: PhaseThinkingConfig;
  /** Feature model settings (insights, ideation, roadmap, githubIssues, githubPrs, utility) */
  featureModels: FeatureModelConfig;
  /** Feature thinking level settings */
  featureThinking: FeatureThinkingConfig;
}

/**
 * Agent settings source configuration
 * Determines where an agent's model and thinking settings come from
 */
export type AgentSettingsSource =
  | { type: 'phase'; phase: 'spec' | 'planning' | 'coding' | 'qa' }
  | { type: 'feature'; feature: 'insights' | 'ideation' | 'roadmap' | 'githubIssues' | 'githubPrs' | 'utility' }
  | { type: 'fixed'; model: string; thinking: ThinkingLevel };

/**
 * Resolved model and thinking for an agent
 */
export interface AgentModelConfig {
  model: string;
  thinking: ThinkingLevel;
}

/**
 * Hook to resolve agent settings from the selected profile and custom overrides
 *
 * @param settings - The application settings containing selected profile and custom overrides
 * @returns Resolved agent settings
 *
 * @example
 * ```tsx
 * const { phaseModels, phaseThinking, featureModels, featureThinking } = useResolvedAgentSettings(settings);
 * ```
 */
export function useResolvedAgentSettings(settings: AppSettings): ResolvedAgentSettings {
  return useMemo(() => {
    const selectedProfileId = settings.selectedAgentProfile ?? 'auto';
    const selectedProfile = DEFAULT_AGENT_PROFILES.find((p) => p.id === selectedProfileId) || DEFAULT_AGENT_PROFILES[0];

    const phaseModels = settings.customPhaseModels ?? selectedProfile.phaseModels ?? DEFAULT_PHASE_MODELS;
    const phaseThinking = settings.customPhaseThinking ?? selectedProfile.phaseThinking ?? DEFAULT_PHASE_THINKING;
    const featureModels = settings.featureModels ?? DEFAULT_FEATURE_MODELS;
    const featureThinking = settings.featureThinking ?? DEFAULT_FEATURE_THINKING;

    return { phaseModels, phaseThinking, featureModels, featureThinking };
  }, [
    settings.selectedAgentProfile,
    settings.customPhaseModels,
    settings.customPhaseThinking,
    settings.featureModels,
    settings.featureThinking,
  ]);
}

/**
 * Resolves model and thinking settings for a specific agent based on its settings source
 *
 * @param settingsSource - The agent's settings source (phase, feature, or fixed)
 * @param resolvedSettings - The resolved agent settings from useResolvedAgentSettings
 * @returns Model and thinking configuration for the agent
 *
 * @example
 * ```tsx
 * const resolvedSettings = useResolvedAgentSettings(settings);
 * const { model, thinking } = resolveAgentSettings(agentConfig.settingsSource, resolvedSettings);
 * ```
 */
export function resolveAgentSettings(
  settingsSource: AgentSettingsSource,
  resolvedSettings: ResolvedAgentSettings
): AgentModelConfig {
  if (settingsSource.type === 'phase') {
    return {
      model: resolvedSettings.phaseModels[settingsSource.phase],
      thinking: resolvedSettings.phaseThinking[settingsSource.phase],
    };
  } else if (settingsSource.type === 'feature') {
    return {
      model: resolvedSettings.featureModels[settingsSource.feature],
      thinking: resolvedSettings.featureThinking[settingsSource.feature],
    };
  } else {
    return {
      model: settingsSource.model,
      thinking: settingsSource.thinking,
    };
  }
}
