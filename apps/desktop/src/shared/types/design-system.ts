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
  /**
   * Exceptions the design system allows (e.g. "repeating-linear-gradient" for a
   * grid background): a finding whose matched text matches one is not reported
   */
  allowedPatterns?: DesignBannedPattern[];
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
  /** Digested references (ready ones), for the agents' prompts */
  references?: DesignReference[];
}

// ---------------------------------------------------------------------------
// References: images, PDFs, token files and sites the design system builds on
// ---------------------------------------------------------------------------

export type DesignReferenceKind = 'image' | 'pdf' | 'tokens' | 'site';

/** "as-is": rules to follow (a brand book, tokens); "inspiration": a direction, not a copy */
export type DesignReferenceRole = 'as-is' | 'inspiration';

export type DesignReferenceStatus = 'pending' | 'digesting' | 'ready' | 'error';

export interface DesignReferenceColor {
  /** #RRGGBB */
  value: string;
  /** Share of the image (0–1), for colours measured from pixels */
  share?: number;
  /** What it seems to be for: background, text, accent… */
  role?: string;
}

/** What one reference brings, written once when it is added */
export interface DesignReferenceNotes {
  /** Two or three sentences: what it is and what it looks like */
  summary: string;
  palette: DesignReferenceColor[];
  fonts: string[];
  /** Light or dark overall */
  theme?: 'light' | 'dark';
  /** Density, corners, shadows, borders, imagery… one short line each */
  traits: string[];
  /** What to take from it (or, for "as-is", the rules it sets) */
  takeaways: string[];
  /** Tokens read exactly from a token file or a site's CSS */
  tokens?: Partial<import('./design-system').DesignTokens>;
}

export interface DesignReference {
  id: string;
  kind: DesignReferenceKind;
  /** File name or page title */
  name: string;
  /** Original file name or URL */
  source: string;
  role: DesignReferenceRole;
  addedAt: string;
  /** Stored file, relative to the project (.vibe-teamlead/design/references/…) */
  file?: string;
  /** PNG the agents look at (an image, a page screenshot, a PDF's first page), relative to the project */
  preview?: string;
  status: DesignReferenceStatus;
  error?: string;
  notes?: DesignReferenceNotes;
}

/** Where the references agree and where they pull apart (computed from the notes) */
export interface DesignReferenceSummary {
  total: number;
  ready: number;
  light: number;
  dark: number;
  /** Colours that recur across references */
  sharedColors: string[];
  /** Fonts that recur across references */
  sharedFonts: string[];
  /** Where they disagree: light vs dark, or different fonts among "as-is" references */
  conflicts: Array<{ kind: 'theme'; light: number; dark: number } | { kind: 'fonts'; fonts: string[] }>;
}

export interface DesignReferenceList {
  references: Array<DesignReference & { /** Small data: URL thumbnail */ thumbnail?: string }>;
  summary: DesignReferenceSummary;
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

/** Storybook of a task's worktree (review components before merging) */
export interface TaskStorybookStatus {
  /** The task has a worktree */
  worktree: boolean;
  /** The worktree has a Storybook and the task changed UI files it shows */
  detected: boolean;
  /** Package manager of the worktree (from its lockfile), for the command shown */
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  dir?: string;
  script?: string;
  /** Dependencies are not installed in the worktree yet */
  needsInstall: boolean;
  installing: boolean;
  running?: { url: string };
}

/** window.electronAPI.design */
/** A brief to bring the existing UI to the design system, from the design check over the whole UI */
export interface RedesignBrief {
  brief: string;
  /** Places that don't follow the design system, and the files they are in */
  findings: number;
  files: number;
}

export interface DesignAPI {
  get: (projectId: string) => Promise<import('./common').IPCResult<DesignSystemInfo>>;
  redesignBrief: (projectId: string) => Promise<import('./common').IPCResult<RedesignBrief>>;
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
  /** Storybook of a task's worktree */
  taskStorybookStatus: (taskId: string, projectId: string) => Promise<import('./common').IPCResult<TaskStorybookStatus>>;
  /** Install the worktree's dependencies if needed, then start its Storybook; progress arrives as onProgress with projectId `task:<taskId>` */
  startTaskStorybook: (taskId: string, projectId: string) => Promise<import('./common').IPCResult<{ url: string }>>;
  stopTaskStorybook: (taskId: string, projectId: string) => Promise<import('./common').IPCResult>;
  /** References of the project's design system */
  listReferences: (projectId: string) => Promise<import('./common').IPCResult<DesignReferenceList>>;
  /** Choose reference files in the system dialog; null when cancelled */
  pickReferenceFiles: () => Promise<import('./common').IPCResult<string[] | null>>;
  /** Absolute path of a file dropped into the renderer */
  pathForFile: (file: File) => string;
  /** Add files (images, PDFs, token files); each is digested once, in the background */
  addReferenceFiles: (projectId: string, paths: string[], role?: DesignReferenceRole) => Promise<import('./common').IPCResult<DesignReferenceList>>;
  /** Add sites by URL */
  addReferenceUrls: (projectId: string, urls: string[], role?: DesignReferenceRole) => Promise<import('./common').IPCResult<DesignReferenceList>>;
  setReferenceRole: (projectId: string, id: string, role: DesignReferenceRole) => Promise<import('./common').IPCResult<DesignReferenceList>>;
  removeReference: (projectId: string, id: string) => Promise<import('./common').IPCResult<DesignReferenceList>>;
  /** Digest a reference again (after an error) */
  retryReference: (projectId: string, id: string) => Promise<import('./common').IPCResult<DesignReferenceList>>;
  /** References changed (a digest finished) */
  onReferencesChanged: (callback: (projectId: string) => void) => () => void;
}
