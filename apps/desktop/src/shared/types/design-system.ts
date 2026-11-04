/**
 * A project's design system: the rules agents build UI by, the tokens the QA
 * design check enforces, and the project's Storybook (optional).
 */

export interface DesignColorToken {
  /** e.g. "ink", "ground", "signal" */
  name: string;
  /** #RRGGBB (or #RGB / #RRGGBBAA) */
  value: string;
  /** What it is for: "text", "background", "accent — attention only", … */
  role?: string;
}

export interface DesignFontToken {
  /** "display", "body", "data", … */
  role: string;
  /** CSS family, e.g. "Archivo" */
  family: string;
}

export interface DesignBannedPattern {
  /** JavaScript regular expression, matched against added lines of UI files */
  pattern: string;
  /** Why it is not allowed, in plain words */
  message: string;
}

/** Machine-checkable part of the design system (design-tokens.json). */
export interface DesignTokens {
  colors: DesignColorToken[];
  fonts: DesignFontToken[];
  /** Allowed border radii in px (e.g. [0] for sharp corners) */
  radius: number[];
  /** Whether box shadows are part of the system */
  shadows: boolean;
  /** Whether gradients are part of the system (default false: a generic-UI tell) */
  gradients?: boolean;
  /** Spacing scale in px */
  spacing?: number[];
  /** Project-specific "never do this" rules */
  bannedPatterns?: DesignBannedPattern[];
}

/** How the QA loop treats design-check findings */
export type DesignQaMode = 'block' | 'warn' | 'off';

export interface StorybookInfo {
  /** Storybook is set up somewhere in the project */
  detected: boolean;
  /** Folder (relative to the project) whose package.json runs Storybook */
  dir?: string;
  /** npm script that starts it, e.g. "storybook" */
  script?: string;
  /** The project allows agents to add Storybook and stories */
  enabled: boolean;
  /** A dev server the app started, if running */
  running?: { url: string; pid?: number };
}

export interface DesignSystemInfo {
  exists: boolean;
  /** "repo": a file in the project's repository; "app": kept by Vibe Teamlead in .vibe-teamlead/ */
  source: 'repo' | 'app' | 'none';
  /** Path of the markdown, relative to the project */
  markdownPath?: string;
  markdown?: string;
  /** Path of design-tokens.json, relative to the project */
  tokensPath?: string;
  tokens?: DesignTokens;
  /** Problems reading the tokens file */
  tokensError?: string;
  qaMode: DesignQaMode;
  storybook: StorybookInfo;
}

/** A visual direction proposed from a brief, before the full system is written */
export interface DesignDirection {
  id: string;
  name: string;
  /** Two or three sentences: the idea and why it fits this product */
  summary: string;
  palette: DesignColorToken[];
  fonts: DesignFontToken[];
  /** What makes it distinctive, and what it deliberately avoids */
  principles: string[];
}

export interface DesignBrief {
  /** What the product is and does */
  product: string;
  /** Who uses it */
  audience?: string;
  /** Mood, references, words — "calm, editorial, like a lab notebook" */
  mood?: string;
}

/** One design-check finding (QA) */
export interface DesignFinding {
  rule: 'off-palette-color' | 'arbitrary-value' | 'radius' | 'shadow' | 'gradient' | 'banned';
  file: string;
  line: number;
  /** The offending text */
  match: string;
  message: string;
}

export interface DesignProgressEvent {
  projectId: string;
  message: string;
}

/** window.electronAPI.design */
export interface DesignAPI {
  get: (projectId: string) => Promise<import('./common').IPCResult<DesignSystemInfo>>;
  save: (projectId: string, content: { markdown?: string; tokens?: DesignTokens }) => Promise<import('./common').IPCResult<DesignSystemInfo>>;
  /** Read the project's styles and components and write the design system they form */
  extract: (projectId: string) => Promise<import('./common').IPCResult<DesignSystemInfo>>;
  /** Three visual directions for a brief (nothing is written) */
  propose: (projectId: string, brief: DesignBrief) => Promise<import('./common').IPCResult<DesignDirection[]>>;
  /** Write the full design system for a chosen direction */
  write: (projectId: string, brief: DesignBrief, direction: DesignDirection) => Promise<import('./common').IPCResult<DesignSystemInfo>>;
  cancel: (projectId: string) => Promise<import('./common').IPCResult>;
  onProgress: (callback: (event: DesignProgressEvent) => void) => () => void;
  /** Start the project's Storybook dev server (or return the running one) */
  startStorybook: (projectId: string) => Promise<import('./common').IPCResult<{ url: string }>>;
  stopStorybook: (projectId: string) => Promise<import('./common').IPCResult>;
}
