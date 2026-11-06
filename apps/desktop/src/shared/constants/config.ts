/**
 * Application configuration constants
 * Default settings, file paths, and project structure
 */

// ============================================
// Terminal Timing Constants
// ============================================

/** Delay for DOM updates before terminal operations (refit, resize).
 * Must be long enough for dnd-kit CSS transitions to complete after drag-drop reorder.
 * 50ms was too short, causing xterm to fit into containers with zero/invalid dimensions. */
export const TERMINAL_DOM_UPDATE_DELAY_MS = 250;

/** Grace period before cleaning up error panel constraints after panel removal */
export const PANEL_CLEANUP_GRACE_PERIOD_MS = 150;

// ============================================
// UI Scale Constants
// ============================================

export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_STEP = 5;

// ============================================
// Default App Settings
// ============================================

export const DEFAULT_APP_SETTINGS = {
  theme: 'light' as const,
  colorTheme: 'default' as const,
  defaultModel: 'opus',
  agentFramework: 'vibe-teamlead',
  pythonPath: undefined as string | undefined,
  gitPath: undefined as string | undefined,
  githubCLIPath: undefined as string | undefined,
  gitlabCLIPath: undefined as string | undefined,
  autoBuildPath: undefined as string | undefined,
  autoNameTerminals: true,
  useClaudeSubscription: false,
  subagentsEnabled: true,
  subagentModel: '',
  securityQaEnabled: false,
  securityQaScanMode: 'quick' as const,
  securityQaFailOn: 'high' as const,
  securityQaMaxBudgetUsd: 5,
  architectMode: 'complex' as const,
  formatOnEdit: true,
  lspEnabled: true,
  onboardingCompleted: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Global API keys (used as defaults for all projects)
  globalOpenAIApiKey: undefined as string | undefined,
  // Selected agent profile - defaults to 'auto' for per-phase optimized model selection
  selectedAgentProfile: 'auto',
  // Changelog preferences (persisted between sessions)
  changelogFormat: 'keep-a-changelog' as const,
  changelogAudience: 'user-facing' as const,
  changelogEmojiLevel: 'none' as const,
  // UI Scale (default 100% - standard size)
  uiScale: UI_SCALE_DEFAULT,
  // Log order setting for task detail view (default chronological - oldest first)
  logOrder: 'chronological' as const,
  // Beta updates opt-in (receive pre-release versions)
  betaUpdates: false,
  // Language preference (default to English)
  language: 'en' as const,
  // Anonymous error reporting (Sentry) - enabled by default to help improve the app
  sentryEnabled: true,
  // Auto-name Claude terminals based on initial message (enabled by default)
  autoNameClaudeTerminals: true,
  // GPU acceleration for terminal rendering
  // Default to 'off' until WebGL stability is proven across all GPU drivers.
  // Users can opt-in via Settings > Display > GPU Acceleration.
  gpuAcceleration: 'off' as const
};

// ============================================
// Default Project Settings
// ============================================

export const DEFAULT_PROJECT_SETTINGS = {
  model: 'opus',
  memoryBackend: 'file' as const,
  linearSync: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Include CLAUDE.md instructions in agent context (enabled by default)
  useClaudeMd: true
};

// ============================================
// Vibe Teamlead File Paths
// ============================================

// File paths relative to project
/** Git branch of a task's worktree: `vibe-teamlead/<specId>` */
export const TASK_BRANCH_PREFIX = 'vibe-teamlead/';
/** Branch prefix of tasks created before the rename (local ones are renamed on load) */
export const LEGACY_TASK_BRANCH_PREFIX = 'auto-claude/';

/** A task branch with a spec id after the prefix (current or legacy prefix). */
export function isTaskBranch(branch: string): boolean {
  return [TASK_BRANCH_PREFIX, LEGACY_TASK_BRANCH_PREFIX].some((prefix) => branch.startsWith(prefix) && branch.length > prefix.length);
}

// IMPORTANT: All paths use .vibe-teamlead/ (the installed instance), never a visible folder
export const AUTO_BUILD_PATHS = {
  SPECS_DIR: '.vibe-teamlead/specs',
  ROADMAP_DIR: '.vibe-teamlead/roadmap',
  IDEATION_DIR: '.vibe-teamlead/ideation',
  IMPLEMENTATION_PLAN: 'implementation_plan.json',
  SPEC_FILE: 'spec.md',
  QA_REPORT: 'qa_report.md',
  BUILD_PROGRESS: 'build-progress.txt',
  GENERATION_PROGRESS: 'generation_progress.json',
  CONTEXT: 'context.json',
  REQUIREMENTS: 'requirements.json',
  ROADMAP_FILE: 'roadmap.json',
  ROADMAP_DISCOVERY: 'roadmap_discovery.json',
  COMPETITOR_ANALYSIS: 'competitor_analysis.json',
  MANUAL_COMPETITORS: 'manual_competitors.json',
  IDEATION_FILE: 'ideation.json',
  IDEATION_CONTEXT: 'ideation_context.json',
  PROJECT_INDEX: '.vibe-teamlead/project_index.json',
  MEMORY_STATE: '.memory_state.json'
} as const;

/**
 * Get the specs directory path.
 * All specs go to .vibe-teamlead/specs/ (the project's data directory).
 */
export function getSpecsDir(autoBuildPath: string | undefined): string {
  const basePath = autoBuildPath || '.vibe-teamlead';
  return `${basePath}/specs`;
}
