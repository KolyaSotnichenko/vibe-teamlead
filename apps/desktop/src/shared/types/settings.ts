/**
 * Application settings types
 */

import type { NotificationSettings, MemoryEmbeddingProvider } from './project';
import type { ChangelogFormat, ChangelogAudience, ChangelogEmojiLevel } from './changelog';
import type { SupportedLanguage } from '../constants/i18n';

// Color theme types for multi-theme support
export type ColorTheme = 'default' | 'dusk' | 'lime' | 'ocean' | 'retro' | 'neo' | 'forest';

// Developer tools preferences - IDE and terminal selection
// Comprehensive list based on Stack Overflow Developer Survey 2024, JetBrains Survey, and market research
export type SupportedIDE =
  // Microsoft/VS Code Ecosystem
  | 'vscode'           // Visual Studio Code (~73% market share)
  | 'visualstudio'     // Visual Studio (full IDE)
  | 'vscodium'         // VSCodium (OSS VS Code without telemetry)
  // AI-Powered Editors (VS Code forks & alternatives)
  | 'cursor'           // Cursor (AI-first VS Code fork)
  | 'windsurf'         // Windsurf by Codeium (AI editor)
  | 'zed'              // Zed (high-performance, Rust-based, AI features)
  | 'void'             // Void (open-source AI editor)
  | 'pearai'           // PearAI (open-source AI editor)
  | 'kiro'             // Kiro by AWS (spec-driven agentic IDE)
  // JetBrains IDEs
  | 'intellij'         // IntelliJ IDEA
  | 'pycharm'          // PyCharm
  | 'webstorm'         // WebStorm
  | 'phpstorm'         // PhpStorm
  | 'rubymine'         // RubyMine
  | 'goland'           // GoLand
  | 'clion'            // CLion (C/C++)
  | 'rider'            // Rider (.NET)
  | 'datagrip'         // DataGrip (Database)
  | 'fleet'            // Fleet (lightweight)
  | 'androidstudio'    // Android Studio (based on IntelliJ)
  | 'aqua'             // Aqua (test automation)
  | 'rustrover'        // RustRover (Rust IDE)
  // Classic Text Editors
  | 'sublime'          // Sublime Text
  | 'vim'              // Vim
  | 'neovim'           // Neovim
  | 'emacs'            // Emacs
  | 'nano'             // GNU Nano
  | 'micro'            // Micro (modern terminal editor)
  | 'helix'            // Helix (modal editor, Rust-based)
  | 'kakoune'          // Kakoune (modal editor)
  // Platform-Specific IDEs
  | 'xcode'            // Xcode (Apple)
  | 'eclipse'          // Eclipse
  | 'netbeans'         // NetBeans
  | 'qtcreator'        // Qt Creator
  | 'codeblocks'       // Code::Blocks
  // macOS-Specific Editors
  | 'nova'             // Nova by Panic
  | 'bbedit'           // BBEdit
  | 'textmate'         // TextMate
  | 'coteditor'        // CotEditor
  // Windows-Specific Editors
  | 'notepadpp'        // Notepad++
  | 'ultraedit'        // UltraEdit
  // Linux Editors
  | 'kate'             // Kate (KDE)
  | 'gedit'            // gedit (GNOME)
  | 'geany'            // Geany
  | 'lapce'            // Lapce (Rust-based, fast)
  | 'lite-xl'          // Lite XL (lightweight)
  // Cloud/Browser-Based IDEs
  | 'codespaces'       // GitHub Codespaces
  | 'gitpod'           // Gitpod
  | 'replit'           // Replit
  | 'codesandbox'      // CodeSandbox
  | 'stackblitz'       // StackBlitz
  | 'cloud9'           // AWS Cloud9
  | 'cloudshell'       // Google Cloud Shell Editor
  | 'coder'            // Coder (self-hosted)
  | 'glitch'           // Glitch
  | 'codepen'          // CodePen
  | 'jsfiddle'         // JSFiddle
  | 'colab'            // Google Colab (notebooks)
  | 'jupyter'          // Jupyter/JupyterLab
  | 'dataspell'        // DataSpell (JetBrains data science)
  // Archived/Legacy (still in use)
  | 'atom'             // Atom (archived but still used)
  | 'brackets'         // Brackets (archived)
  // Custom option
  | 'custom';

// Comprehensive terminal emulator support
// Based on GitHub stars, Reddit discussions, and developer surveys
export type SupportedTerminal =
  // System Defaults
  | 'system'           // System default terminal
  // macOS Terminals
  | 'terminal'         // Terminal.app (macOS default)
  | 'iterm2'           // iTerm2 (most popular macOS)
  | 'warp'             // Warp (AI-powered, modern)
  | 'ghostty'          // Ghostty (by Mitchell Hashimoto)
  | 'rio'              // Rio (Rust-based, GPU-accelerated)
  // Windows Terminals
  | 'windowsterminal'  // Windows Terminal (Microsoft)
  | 'powershell'       // PowerShell
  | 'cmd'              // Command Prompt
  | 'conemu'           // ConEmu
  | 'cmder'            // Cmder (ConEmu-based)
  | 'gitbash'          // Git Bash
  | 'cygwin'           // Cygwin
  | 'msys2'            // MSYS2
  // Linux Terminals (Desktop Environment defaults)
  | 'gnometerminal'    // GNOME Terminal
  | 'konsole'          // Konsole (KDE)
  | 'xfce4terminal'    // XFCE4 Terminal
  | 'lxterminal'       // LXTerminal
  | 'mate-terminal'    // MATE Terminal
  // Linux Terminals (Feature-rich)
  | 'terminator'       // Terminator (split panes)
  | 'tilix'            // Tilix (tiling terminal)
  | 'guake'            // Guake (dropdown)
  | 'yakuake'          // Yakuake (KDE dropdown)
  | 'tilda'            // Tilda (dropdown)
  // GPU-Accelerated Terminals (Cross-platform)
  | 'alacritty'        // Alacritty (Rust, ~56k GitHub stars)
  | 'kitty'            // Kitty (Python/C, ~25k GitHub stars)
  | 'wezterm'          // WezTerm (Rust, multiplexer built-in)
  // Cross-Platform Terminals
  | 'hyper'            // Hyper (Electron-based)
  | 'tabby'            // Tabby (formerly Terminus)
  | 'extraterm'        // Extraterm (frames-based)
  | 'contour'          // Contour (modern VT)
  // Minimal/Suckless Terminals
  | 'xterm'            // xterm (X11 classic)
  | 'urxvt'            // rxvt-unicode
  | 'st'               // st (suckless terminal)
  | 'foot'             // Foot (Wayland)
  // Specialty/Retro Terminals
  | 'coolretroterm'    // cool-retro-term (CRT aesthetic)
  // Multiplexers (often used as terminal environment)
  | 'tmux'             // tmux (terminal multiplexer)
  | 'zellij'           // Zellij (modern multiplexer)
  // AI-Enhanced
  | 'fig'              // Fig / Amazon Q Developer (autocomplete)
  // Custom option
  | 'custom';

// CLI tools for AI-powered terminal sessions
export type SupportedCLI =
  | 'claude-code'   // Claude Code CLI
  | 'gemini'        // Gemini CLI
  | 'opencode'      // OpenCode
  | 'kilocode'      // Kilo Code CLI
  | 'codex'         // Codex CLI
  | 'custom';

export interface ThemePreviewColors {
  bg: string;
  accent: string;
  darkBg: string;
  darkAccent?: string;
}

export interface ColorThemeDefinition {
  id: ColorTheme;
  name: string;
  description: string;
  previewColors: ThemePreviewColors;
}

// Thinking level for model (budget token allocation or reasoning effort)
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh';

// Model type shorthand
/** When the architect agent runs: always, only for complex tasks, or never */
export type ArchitectMode = 'always' | 'complex' | 'never';
export const ARCHITECT_MODES: readonly ArchitectMode[] = ['always', 'complex', 'never'];
export const DEFAULT_ARCHITECT_MODE: ArchitectMode = 'complex';

export type ModelTypeShort = 'haiku' | 'sonnet' | 'opus' | 'opus-1m' | 'opus-4.5';

/** Widened model type: Claude shorthands + any arbitrary model ID */
export type ModelSelection = ModelTypeShort | (string & {});

// Phase-based model configuration for Auto profile
// Each phase can use a different model optimized for that task type
// Values are Claude shorthands ('opus', 'sonnet', 'haiku') or full Claude model IDs
export interface PhaseModelConfig {
  spec: string;       // Spec creation (discovery, requirements, context)
  planning: string;   // Implementation planning
  coding: string;     // Actual coding implementation
  qa: string;         // QA review and fixing
}

// Thinking level configuration per phase
export interface PhaseThinkingConfig {
  spec: ThinkingLevel;
  planning: ThinkingLevel;
  coding: ThinkingLevel;
  qa: ThinkingLevel;
}

// Feature-specific model configuration (for non-pipeline features)
// Values are Claude shorthands or full Claude model IDs
export interface FeatureModelConfig {
  insights: string;    // Insights chat feature
  ideation: string;    // Ideation generation
  roadmap: string;     // Roadmap generation
  githubIssues: string; // GitHub Issues automation
  githubPrs: string;    // GitHub PR review automation
  utility: string;      // Utility agents (commit message, merge resolver)
  naming: string;       // AI naming (task titles, terminal names)
  briefImport: string;  // Spec document (ТЗ) → tasks
  designSystem: string; // Design system: extract from code, generate directions
}

// Feature-specific thinking level configuration
export interface FeatureThinkingConfig {
  insights: ThinkingLevel;
  ideation: ThinkingLevel;
  roadmap: ThinkingLevel;
  githubIssues: ThinkingLevel;
  githubPrs: ThinkingLevel;
  utility: ThinkingLevel;
  naming: ThinkingLevel;
  briefImport: ThinkingLevel;
  designSystem: ThinkingLevel;
}

// Agent profile for preset model/thinking configurations
// All profiles have per-phase configuration (phaseModels/phaseThinking)
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  model: string;                   // Primary model (shown in profile card) — shorthand or concrete ID
  thinkingLevel: ThinkingLevel;    // Primary thinking level (shown in profile card)
  icon?: string;                   // Lucide icon name
  // Per-phase configuration - all profiles now have this
  phaseModels?: PhaseModelConfig;
  phaseThinking?: PhaseThinkingConfig;
  /** @deprecated Use phaseModels and phaseThinking for per-phase configuration. Will be removed in v3.0. */
  isAutoProfile?: boolean;
}

// Pipeline phase key type (distinct from task.ts Phase interface which is for plan phases)
export type PipelinePhase = 'spec' | 'planning' | 'coding' | 'qa';

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  colorTheme?: ColorTheme;
  defaultModel: string;
  agentFramework: string;
  pythonPath?: string;
  gitPath?: string;
  githubCLIPath?: string;
  gitlabCLIPath?: string;
  claudePath?: string;
  autoBuildPath?: string;
  autoUpdateAutoBuild: boolean;
  autoNameTerminals: boolean;
  notifications: NotificationSettings;
  /** The sidebar teamlead chirps when the team's mood changes. On unless set to false. */
  teamleadVoice?: boolean;
  /**
   * Personal mode: run agents on the user's own Claude subscription
   * (OAuth token) instead of an API key. Off by default; for the owner's
   * own machine only.
   */
  useClaudeSubscription?: boolean;
  /**
   * Optional Anthropic-compatible endpoint (gateway or proxy) for every
   * Claude session. The API key itself is stored encrypted outside settings
   * (see main/ai/claude-code/credential.ts).
   */
  anthropicBaseUrl?: string;
  /**
   * Security QA: run a Strix penetration test after QA approves (needs Docker,
   * Strix and an API key). Off by default — it spends LLM budget.
   */
  /** Helper subagents (explorer, test runner, reviewer) for the planner, coder and QA */
  subagentsEnabled?: boolean;
  /** Model of the helper subagents; empty = the same model as the agent */
  subagentModel?: string;
  securityQaEnabled?: boolean;
  securityQaScanMode?: 'quick' | 'standard' | 'deep';
  securityQaFailOn?: 'critical' | 'high' | 'medium' | 'low';
  /** Spend cap per scan, USD */
  securityQaMaxBudgetUsd?: number;
  /**
   * When the architect designs before the planner: for every task, only for
   * tasks the complexity assessment rates complex (default), or never.
   */
  architectMode?: ArchitectMode;
  /**
   * After each file the coder or QA fixer writes, run the project's own
   * formatter and linter on it and feed the findings back. On unless false.
   */
  formatOnEdit?: boolean;
  /**
   * Language servers (TypeScript/JavaScript and Python bundled; gopls,
   * rust-analyzer, clangd when installed) for the coder and QA fixer. On
   * unless false; turn off on very large repositories if memory is a problem.
   */
  lspEnabled?: boolean;
  // API keys used by memory embeddings (OpenAI, Google)
  globalOpenAIApiKey?: string;
  globalGoogleApiKey?: string;
  ollamaBaseUrl?: string;
  // Memory configuration (app-wide, set during onboarding)
  memoryEnabled?: boolean;
  memoryEmbeddingProvider?: MemoryEmbeddingProvider;
  memoryOllamaEmbeddingModel?: string;
  memoryOllamaEmbeddingDim?: number;
  memoryVoyageApiKey?: string;
  memoryVoyageEmbeddingModel?: string;
  memoryAzureApiKey?: string;
  memoryAzureBaseUrl?: string;
  memoryAzureEmbeddingDeployment?: string;
  memoryGoogleApiKey?: string;
  memoryOpenaiEmbeddingModel?: string;
  memoryGoogleEmbeddingModel?: string;
  // Onboarding wizard completion state
  onboardingCompleted?: boolean;
  // Selected agent profile for preset model/thinking configurations
  selectedAgentProfile?: string;
  // Custom phase configuration for Auto profile (overrides defaults)
  customPhaseModels?: PhaseModelConfig;
  customPhaseThinking?: PhaseThinkingConfig;
  // Feature-specific configuration (insights, ideation, roadmap)
  featureModels?: FeatureModelConfig;
  featureThinking?: FeatureThinkingConfig;
  // Changelog preferences
  changelogFormat?: ChangelogFormat;
  changelogAudience?: ChangelogAudience;
  changelogEmojiLevel?: ChangelogEmojiLevel;
  // UI Scale setting (75-200%, default 100)
  uiScale?: number;
  // Log order setting for task detail view
  logOrder?: 'chronological' | 'reverse-chronological';
  // Beta updates opt-in (receive pre-release updates)
  betaUpdates?: boolean;
  // Migration flags (internal use)
  _migratedAgentProfileToAuto?: boolean;
  _migratedDefaultModelSync?: boolean;
  _migratedUltrathinkToHigh?: boolean;
  // Language preference for UI (i18n)
  language?: SupportedLanguage;
  // Developer tools preferences
  preferredIDE?: SupportedIDE;
  customIDEPath?: string;      // For 'custom' IDE
  preferredTerminal?: SupportedTerminal;
  customTerminalPath?: string; // For 'custom' terminal
  preferredCLI?: SupportedCLI;
  customCLIPath?: string;
  // YOLO mode: invoke Claude with --dangerously-skip-permissions flag
  dangerouslySkipPermissions?: boolean;
  // Anonymous error reporting (Sentry) - enabled by default to help improve the app
  sentryEnabled?: boolean;
  // Auto-name Claude terminals based on initial message (only triggers once per session)
  autoNameClaudeTerminals?: boolean;
  // Sidebar collapsed state (icons only when true)
  sidebarCollapsed?: boolean;
  // GPU acceleration for terminal rendering (WebGL)
  gpuAcceleration?: GpuAcceleration;
}

// GPU acceleration mode for terminal WebGL rendering
export type GpuAcceleration = 'auto' | 'on' | 'off';


