/**
 * The in-app Preview: the project's app from main, run while its view is open.
 */

import type { IPCResult } from './common';
import type { SaidText } from '../constants/preview-say';
import type { PreviewService } from './project';

/** One command of a recipe's step, run in `dir` (relative to the project root; '' for the root) */
export interface PreviewRecipeCommand {
  dir: string;
  command: string;
}

/** What a recipe's project is: only `web` is shown in the Preview for now */
export type PreviewRecipeKind = 'web' | 'desktop' | 'mobile' | 'none';

/**
 * How the Preview runs a project, from `preview.json` at its root (preview/recipe.ts). What it
 * doesn't say is detected; what it says replaces the detection for that item.
 */
export interface PreviewRecipe {
  version: 1;
  kind: PreviewRecipeKind;
  services?: PreviewService[];
  /** Each list replaces its stage; an empty list skips it */
  steps?: { install?: PreviewRecipeCommand[]; build?: PreviewRecipeCommand[]; migrate?: PreviewRecipeCommand[]; seed?: PreviewRecipeCommand[] };
  /** Values every service gets; a service's own `env` wins */
  env?: Record<string, string>;
}

/**
 * Where the recipe a start uses came from: one made in the app that is not in main yet, the
 * project's `preview.json`, the services the owner saved, the proposal from the project's files
 * (one page, nothing to ask), or nothing
 */
export type PreviewRecipeSource = 'pending' | 'file' | 'settings' | 'proposal' | 'none';

/**
 * A recipe made in the app that is not in the project's main branch yet (preview/pending-recipe.ts):
 * used at once, and written into main by the app
 */
export interface PendingRecipe {
  recipe: PreviewRecipe;
  /** The hash of the preview.json it replaces, 'none' when there was none */
  base: string;
  origin: 'owner' | 'agent';
  at: string;
}

export type PreviewStage = 'worktree' | 'install' | 'libraries' | 'database' | 'migrations' | 'seed' | 'services' | 'ready' | 'failed' | 'stopped';

export interface PreviewStatus {
  projectId: string;
  /** Set for a task's preview (its worktree), absent for the project's (main) */
  taskId?: string;
  stage: PreviewStage;
  url?: string;
  /** Where the view may navigate */
  origins: string[];
  message?: string;
  logTail?: string;
  /** A service that exited on its own after the preview was ready */
  stoppedService?: string;
  database?: 'none' | 'started' | 'unavailable';
  databaseReason?: string;
  /** The compose file's other services, when it names any */
  services?: 'started' | 'unavailable';
  /** What didn't start among them, and why */
  servicesNotices?: string[];
  /** A local mail catcher, when the project's settings configure SMTP */
  mail?: 'started' | 'unavailable';
  mailReason?: string;
  /** Why the page may not reach a service: an address the project hard-codes, or a failed request through the page */
  addressIssues?: PreviewAddressIssue[];
  /** Where the recipe this start uses came from, and why the project's preview.json was passed over, when it was */
  recipe?: { source: PreviewRecipeSource; kind: PreviewRecipeKind; invalid?: string };
  /** Failed because no source says which services to run, or which one is the page: the owner is asked */
  needsServices?: true;
  /**
   * Which of this status's sentences (its failure message, its reasons and notices) the app
   * made itself, with the key and values to say each in the interface's language
   */
  said?: SaidText[];
}

/**
 * A service the page can't reach in the preview. With `file`: a config there names the
 * service's own port (`ownPort`), but the preview runs it on `previewPort` because its own
 * was taken. With `unreachable`: a request through the page to a proxied path failed.
 */
export interface PreviewAddressIssue {
  /** The service the page can't reach, when known */
  service?: string;
  /** The service whose config names the address */
  from?: string;
  /** That service's folder ('' for the root): where the fix's example setting goes */
  fromDir?: string;
  file?: string;
  line?: number;
  /** As written, e.g. `http://localhost:3000` */
  address?: string;
  ownPort?: number;
  previewPort?: number;
  /** The path requested through the page and what came back: a status or an error code */
  unreachable?: { path: string; result: string };
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** signOut: clears the page's cookies and storage, then reloads it */
export type PreviewNavigation = { action: 'back' | 'forward' | 'reload' | 'signOut' } | { url: string };

/** What the page's notes overlay reports, after the main process checked it */
export type PreviewOverlayEvent =
  | { type: 'picked'; route: string; width: number; pick: import('../../preview-overlay/protocol').Pick; image?: string }
  | { type: 'detached'; ns: number[] }
  | { type: 'escape' }
  | { type: 'route'; route: string };

/** A note the owner left on an element or a region of the previewed app */
export interface PreviewNote {
  id: string;
  /** Its pin's number */
  n: number;
  route: string;
  /** The view's width when it was left, in pixels */
  width: number;
  text: string;
  pick: import('../../preview-overlay/protocol').Pick;
  /** PNG data URL of the element or region */
  image?: string;
  createdAt: string;
}

/** A message the app sent, caught by the preview's local mail catcher */
export interface PreviewMailSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  at: string;
  snippet: string;
}

export interface PreviewMailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  at: string;
  text: string;
  /** Links in the message, to open in the preview */
  links: string[];
}

/** One problem the UX review found on the running app */
export interface UxFinding {
  /** The route, e.g. `/login` */
  page: string;
  /** The width it was seen at, in pixels */
  width: number;
  /** blocks: a person can't use the page as meant; note: polish */
  severity: 'blocks' | 'note';
  problem: string;
  expected: string;
  /** The source file to change, when the reviewer found it */
  file?: string;
}

export interface UxReviewResult {
  findings: UxFinding[];
  summary: string;
  /** The pages it opened */
  pages: string[];
  at: string;
}

/** The project's RUNNING.md (how to run it) and the folder it was read from */
export type PreviewRunningDoc = ({ exists: false } | { exists: true; markdown: string; truncated: boolean }) & { dir: string };

/**
 * Where a preview variable's value came from: the project's example settings (root or the
 * service's folder), the preview's own database, another compose service it started (a
 * queue, storage, search: `service` names it) or its mail catcher, left empty on purpose (it
 * would connect to a real service), another service's preview address, the port the
 * preview chose, the project's recipe (preview.json), or the owner's value (for all services
 * or this one).
 */
export type PreviewEnvSource = 'example' | 'exampleDir' | 'database' | 'service' | 'mail' | 'blocked' | 'address' | 'port' | 'recipe' | 'override' | 'serviceOverride';

export interface PreviewEnvVar {
  name: string;
  value: string;
  source: PreviewEnvSource;
  /** The compose service the value points at (source `service`, or `blocked` when it didn't start) */
  service?: string;
  /** What the preview would set without the owner's value, and where that came from */
  automatic?: { value: string; source: PreviewEnvSource };
  /** Known only once the preview starts (a database's address, a port) */
  pending?: boolean;
  /** For a service in a folder: named only by the project root's `.env.example`, so every service gets it */
  shared?: boolean;
}

export interface PreviewEnvService {
  service: string;
  dir: string;
  vars: PreviewEnvVar[];
}

export interface PreviewEnvReport {
  /** Whether the values are what the running services got, or what they will get at the next start */
  running: boolean;
  /** The saved values differ from what the running services started with */
  restartNeeded: boolean;
  /** The database kinds the project's compose file names, which the preview starts for it, e.g. postgres */
  databases: string[];
  /** The other compose services (queues, storage, search…) the preview starts for it, by compose name */
  composeServices?: string[];
  /** Whether the project sends mail, which the preview catches */
  mail: boolean;
  /** Docker isn't running or isn't installed, so the test database and mail catcher can't start */
  dockerUnavailable: boolean;
  services: PreviewEnvService[];
}

/** The services a start would run, where they came from, and why the project's preview.json was passed over, when it was */
export interface PreviewRecipeInfo {
  source: PreviewRecipeSource;
  /** Where the services came from: a preview.json without services takes them from the saved ones or the proposal */
  servicesFrom: PreviewRecipeSource;
  services: PreviewService[];
  invalid?: string;
  /** Set when the recipe in use was made in the app and is not in main yet: whose it is, and why the last try to write it was refused */
  pending?: { origin: 'owner' | 'agent'; refusal?: string; refusalSaid?: SaidText };
}

export interface PreviewAPI {
  /** `taskId`: that task's worktree instead of main */
  start: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewStatus>>;
  stop: () => Promise<IPCResult>;
  onStatus: (callback: (status: PreviewStatus) => void) => () => void;
  setBounds: (bounds: PreviewBounds | null) => Promise<IPCResult>;
  navigate: (navigation: PreviewNavigation) => Promise<IPCResult>;
  /** `taskId`: from that task's folder */
  proposeServices: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewService[]>>;
  /** What the preview runs for this project (or that task) and where that came from */
  recipe: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewRecipeInfo>>;
  /**
   * Changes the services of the project's recipe (preview.json): used at once, and written into
   * the project's main branch by the app. `errorSaid`: the refusal as a sentence the interface can translate.
   */
  saveRecipeServices: (projectId: string, services: PreviewService[]) => Promise<IPCResult<PreviewRecipeInfo> & { errorSaid?: SaidText }>;
  resetData: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewStatus>>;
  /** Reviews the running preview's pages as a person would use them (one agent session) */
  uxReview: (projectId: string) => Promise<IPCResult<UxReviewResult>>;
  cancelUxReview: () => Promise<IPCResult>;
  /** The last review of this project, if any */
  lastUxReview: (projectId: string) => Promise<IPCResult<UxReviewResult | null>>;
  /** The end of each running service's log */
  logs: (projectId: string) => Promise<IPCResult<Array<{ service: string; text: string }>>>;
  /** What the app sent, caught by the preview's mail catcher */
  mailList: (projectId: string) => Promise<IPCResult<PreviewMailSummary[]>>;
  mailGet: (projectId: string, id: string) => Promise<IPCResult<PreviewMailMessage | null>>;
  /** Notes mode: the page outlines elements and takes clicks and drags as notes */
  setNotesMode: (on: boolean) => Promise<IPCResult>;
  /** The pins of the page's current route */
  setPins: (pins: Array<{ n: number; selector: string }>) => Promise<IPCResult>;
  focusPin: (n: number) => Promise<IPCResult>;
  onOverlayEvent: (callback: (event: PreviewOverlayEvent) => void) => () => void;
  loadNotes: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewNote[]>>;
  /** RUNNING.md from the project's root, or the task's worktree */
  runningDoc: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewRunningDoc>>;
  /** Every variable each service gets (or will get), with where it came from */
  env: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewEnvReport>>;
  /** Restarts the services with the saved values; starts the preview when it isn't running */
  restartServices: (projectId: string, taskId?: string) => Promise<IPCResult<PreviewStatus>>;
  /** Replaces the draft; returns what was kept */
  saveNotes: (projectId: string, notes: PreviewNote[], taskId?: string) => Promise<IPCResult<PreviewNote[]>>;
}
