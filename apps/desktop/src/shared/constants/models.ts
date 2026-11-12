/**
 * Model and agent profile constants
 * Claude models, thinking levels, memory backends, and agent profiles
 */

import type { AgentProfile, PhaseModelConfig, FeatureModelConfig, FeatureThinkingConfig } from '../types/settings';

// ============================================
// Available Models
// ============================================

/**
 * Names of the shorthands (resolved by MODEL_ID_MAP) settings and tasks may
 * hold. Not choices: the pickers offer what the configured endpoint lists, and
 * accept any typed model id.
 */
export const AVAILABLE_MODELS = [
  { value: 'opus', label: 'Claude Opus 5.5' },
  { value: 'opus-1m', label: 'Claude Opus 5.5 (1M)' },
  { value: 'sonnet', label: 'Claude Sonnet 5.5' },
  { value: 'haiku', label: 'Claude Haiku 5.5' }
] as const;

/** Labels for shorthands no longer offered, so old settings still read well */
export const LEGACY_MODEL_LABELS: Record<string, string> = {
  'opus-4.5': 'Claude Opus 4.5'
};

/**
 * Model ids of the providers that were removed. Settings and tasks may still
 * name them; they fall back to the default Claude model.
 */
export const REMOVED_PROVIDER_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1-codex-mini', 'gpt-5-nano', 'o3', 'o4-mini',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash',
  'mistral-large-latest', 'mistral-small-latest', 'meta-llama/llama-4-maverick', 'llama-3.3-70b-versatile',
  'grok-4-0709', 'grok-3', 'grok-3-mini', 'glm-5', 'glm-4.7', 'glm-4.6v', 'glm-4.5-flash'
]);

// Maps model shorthand to actual Claude model IDs
// Values must match apps/desktop/src/main/ai/config/types.ts MODEL_ID_MAP
export const MODEL_ID_MAP: Record<string, string> = {
  opus: 'claude-opus-5-5',
  'opus-1m': 'claude-opus-5-5',
  'opus-4.5': 'claude-opus-4-5-20251101',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5'
} as const;

// Maps thinking levels to budget tokens
export const THINKING_BUDGET_MAP: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768
} as const;

// ============================================
// Thinking Levels
// ============================================

// Thinking levels for Claude model (budget token allocation)
export const THINKING_LEVELS = [
  { value: 'low', label: 'Low', description: 'Brief consideration' },
  { value: 'medium', label: 'Medium', description: 'Moderate analysis' },
  { value: 'high', label: 'High', description: 'Deep thinking' },
  { value: 'xhigh', label: 'Extra High', description: 'Maximum reasoning' }
] as const;

// ============================================
// Agent Profiles - Phase Configurations
// ============================================

// Phase configurations for each preset profile
// Each profile has its own default phase models and thinking levels

// Auto (Optimized) - Opus with optimized thinking per phase
export const AUTO_PHASE_MODELS: PhaseModelConfig = {
  spec: 'opus',
  planning: 'opus',
  coding: 'opus',
  qa: 'opus'
};

export const AUTO_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'high',   // Deep thinking for comprehensive spec creation
  planning: 'high',     // High thinking for planning complex features
  coding: 'low',        // Faster coding iterations
  qa: 'low'             // Efficient QA review
};

// Complex Tasks - Opus with high thinking across all phases
export const COMPLEX_PHASE_MODELS: PhaseModelConfig = {
  spec: 'opus',
  planning: 'opus',
  coding: 'opus',
  qa: 'opus'
};

export const COMPLEX_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'high',
  planning: 'high',
  coding: 'high',
  qa: 'high'
};

// Balanced - Sonnet with medium thinking across all phases
export const BALANCED_PHASE_MODELS: PhaseModelConfig = {
  spec: 'sonnet',
  planning: 'sonnet',
  coding: 'sonnet',
  qa: 'sonnet'
};

export const BALANCED_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'medium',
  planning: 'medium',
  coding: 'medium',
  qa: 'medium'
};

// Quick Edits - Haiku with low thinking across all phases
export const QUICK_PHASE_MODELS: PhaseModelConfig = {
  spec: 'haiku',
  planning: 'haiku',
  coding: 'haiku',
  qa: 'haiku'
};

export const QUICK_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'low',
  planning: 'low',
  coding: 'low',
  qa: 'low'
};

// Default phase configuration (used for fallback, matches 'Balanced' profile for cost-effectiveness)
export const DEFAULT_PHASE_MODELS: PhaseModelConfig = BALANCED_PHASE_MODELS;
export const DEFAULT_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = BALANCED_PHASE_THINKING;

// ============================================
// Feature Settings (Non-Pipeline Features)
// ============================================

// Default feature model configuration (for insights, ideation, roadmap, github, utility, naming)
export const DEFAULT_FEATURE_MODELS: FeatureModelConfig = {
  insights: 'sonnet',     // Fast, responsive chat
  ideation: 'opus',       // Creative ideation benefits from Opus
  roadmap: 'opus',        // Strategic planning benefits from Opus
  githubIssues: 'opus',   // Issue triage and analysis benefits from Opus
  githubPrs: 'opus',      // PR review benefits from thorough Opus analysis
  utility: 'haiku',       // Fast utility operations (commit messages, merge resolution)
  naming: 'haiku',        // Fast, cheap model for task titles and terminal names
  briefImport: 'opus',    // Reads the whole spec document and the project
  designSystem: 'opus',   // Visual direction and a coherent token system
  uxReview: 'sonnet',     // Goes through the running app in a browser
  designer: 'sonnet',     // Wireframes and screens in the design system, as HTML
  deployReadiness: 'sonnet' // Reads the project for what blocks a first deploy
};

// Default feature thinking configuration
export const DEFAULT_FEATURE_THINKING: FeatureThinkingConfig = {
  insights: 'medium',     // Balanced thinking for chat
  ideation: 'high',       // Deep thinking for creative ideas
  roadmap: 'high',        // Strategic thinking for roadmap
  githubIssues: 'medium', // Moderate thinking for issue analysis
  githubPrs: 'medium',    // Moderate thinking for PR review
  utility: 'low',         // Fast thinking for utility operations
  naming: 'low',          // No thinking needed for short name generation
  briefImport: 'high',    // Splitting a spec into tasks needs deep thinking
  designSystem: 'high',   // Distinctive, consistent design choices
  uxReview: 'medium',     // Many pages and states, judged against checklists
  designer: 'medium',     // Layout and states from the spec, then the design system
  deployReadiness: 'low'  // A read-only scan with a fixed checklist
};

// Feature labels for UI display
export const FEATURE_LABELS: Record<keyof FeatureModelConfig, { label: string; description: string }> = {
  insights: { label: 'Insights Chat', description: 'Ask questions about your codebase' },
  ideation: { label: 'Ideation', description: 'Generate feature ideas and improvements' },
  roadmap: { label: 'Roadmap', description: 'Create strategic feature roadmaps' },
  githubIssues: { label: 'GitHub Issues', description: 'Automated issue triage and labeling' },
  githubPrs: { label: 'GitHub PR Review', description: 'AI-powered pull request reviews' },
  utility: { label: 'Utility', description: 'Commit messages and merge conflict resolution' },
  naming: { label: 'AI Naming', description: 'Task titles and terminal tab names' },
  briefImport: { label: 'Spec document import', description: 'Splits an uploaded spec document into tasks' },
  designSystem: { label: 'Design system', description: 'Extracts or designs the project design system' },
  uxReview: { label: 'UX review', description: "Reviews the running app in Preview as a person would use it" },
  designer: { label: 'Designer', description: 'Draws wireframes and screens before the code of tasks that change UI' },
  deployReadiness: { label: 'Deploy readiness', description: 'Scans the project for what blocks a first deploy' },
};

// Default agent profiles for preset model/thinking configurations
// All profiles have per-phase configuration for full customization
export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'auto',
    name: 'Auto (Optimized)',
    description: 'Uses Opus across all phases with optimized thinking levels',
    model: 'opus',
    thinkingLevel: 'high',
    icon: 'Sparkles',
    phaseModels: AUTO_PHASE_MODELS,
    phaseThinking: AUTO_PHASE_THINKING
  },
  {
    id: 'complex',
    name: 'Complex Tasks',
    description: 'For intricate, multi-step implementations requiring deep analysis',
    model: 'opus',
    thinkingLevel: 'high',
    icon: 'Brain',
    phaseModels: COMPLEX_PHASE_MODELS,
    phaseThinking: COMPLEX_PHASE_THINKING
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Good balance of speed and quality for most tasks',
    model: 'sonnet',
    thinkingLevel: 'medium',
    icon: 'Scale',
    phaseModels: BALANCED_PHASE_MODELS,
    phaseThinking: BALANCED_PHASE_THINKING
  },
  {
    id: 'quick',
    name: 'Quick Edits',
    description: 'Fast iterations for simple changes and quick fixes',
    model: 'haiku',
    thinkingLevel: 'low',
    icon: 'Zap',
    phaseModels: QUICK_PHASE_MODELS,
    phaseThinking: QUICK_PHASE_THINKING
  },
];

// Models that support Fast Mode (same model, faster API routing, higher cost)
export const FAST_MODE_MODELS: readonly string[] = ['opus', 'opus-1m'] as const;

// Models that think adaptively, with an effort level (the 5.5 family: Opus, Sonnet and Haiku)
export const ADAPTIVE_THINKING_MODELS: readonly string[] = [
  'opus', 'opus-1m', 'sonnet', 'haiku',
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
] as const;

// Valid thinking levels for validation
export const VALID_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

// Legacy thinking level mappings (must match backend phase_config.py LEGACY_THINKING_LEVEL_MAP)
export const LEGACY_THINKING_MAP: Record<string, string> = { ultrathink: 'high', none: 'low' } as const;

/** Sanitize a thinking level value, mapping legacy values to valid ones */
export function sanitizeThinkingLevel(val: string): string {
  if (VALID_THINKING_LEVELS.includes(val as typeof VALID_THINKING_LEVELS[number])) return val;
  return LEGACY_THINKING_MAP[val] ?? 'medium';
}

// Phase keys for iterating over phase model/thinking configuration
export const PHASE_KEYS: readonly (keyof PhaseModelConfig)[] = ['spec', 'planning', 'coding', 'qa'] as const;

// ============================================
// Memory Backends
// ============================================

export const MEMORY_BACKENDS = [
  { value: 'file', label: 'File-based (default)' },
  { value: 'memory', label: 'Memory (LadybugDB)' }
] as const;

// ============================================
// Thinking (reasoning) per Claude model
// ============================================

export type ReasoningType =
  | 'thinking_tokens'     // budget-based extended thinking
  | 'adaptive_effort'     // current models: an effort level, the model decides how much to think
  | 'none';               // no extended thinking

export const REASONING_TYPE_BADGES: Record<ReasoningType, { i18nKey: string } | null> = {
  adaptive_effort: { i18nKey: 'agentProfile.reasoning.adaptive' },
  thinking_tokens: { i18nKey: 'agentProfile.reasoning.budget' },
  none: null,
};

/** How a Claude model thinks. Haiku before 5.5 has no thinking the app can set. */
export function getReasoningTypeForModel(modelValue: string): ReasoningType {
  if (ADAPTIVE_THINKING_MODELS.includes(modelValue)) return 'adaptive_effort';
  if (modelValue === 'haiku' || modelValue.includes('haiku')) return 'none';
  return 'thinking_tokens';
}
