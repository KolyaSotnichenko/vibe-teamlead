/**
 * Deploy view types: GitHub Actions runs, jobs and deployments.
 * Shared across main, preload and renderer.
 */

export type DeployStatus = 'queued' | 'in_progress' | 'completed' | 'waiting';

export type GitHubErrorKind = 'no-connection' | 'permissions' | 'not-found' | 'rate-limit' | 'unavailable';

export interface GitHubError {
  kind: GitHubErrorKind;
  /** ISO time when the rate limit resets (rate-limit only). */
  resetAt?: string;
  /** The HTTP status GitHub answered with (unavailable only; absent when GitHub could not be reached). */
  status?: number;
  message: string;
}

export interface DeployRun {
  id: number;
  /** The run's number in its workflow (`#17` on GitHub). */
  number: number;
  name: string;
  title: string;
  branch: string;
  sha: string;
  event: string;
  status: DeployStatus;
  conclusion?: string;
  startedAt: string;
  updatedAt: string;
  htmlUrl: string;
  workflowPath: string;
  /** `owner/repo` the run's commit came from; differs from the repository for a fork's pull request */
  headRepo?: string;
}

export interface DeployStep {
  name: string;
  status: DeployStatus;
  conclusion?: string;
  number: number;
  startedAt?: string;
  completedAt?: string;
}

export interface DeployJob {
  id: number;
  name: string;
  status: DeployStatus;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  steps: DeployStep[];
}

/**
 * A task's CI status: the GitHub Actions runs of its branch (`vibe-teamlead/<specId>`) for the last
 * pushed commit; a run of an older commit does not count. `waiting`: no run of that commit yet; `settled`: none came within 10 minutes of the push, none is expected.
 * `failed` carries the failed run (and its failed job) for the Deploy page's Runs tab.
 */
export type TaskCiState =
  | { state: 'not-set-up' }
  | { state: 'unavailable'; reason: 'public-repo' | 'push-off' }
  | { state: 'not-pushed'; pushError?: string }
  | { state: 'waiting'; settled?: boolean; pushError?: string }
  | { state: 'running'; pushError?: string }
  | { state: 'passed'; pushError?: string }
  | { state: 'failed'; runId: number; jobId?: number; pushError?: string };

/** Where the Deploy page should open (the `open-deploy` window event's detail). */
export interface DeployTarget {
  tab?: 'runs' | 'readiness' | 'environment';
  runId?: number;
  jobId?: number;
}

export type GraphNodeStatus = 'queued' | 'running' | 'success' | 'failure' | 'skipped' | 'cancelled';

export interface GraphNode {
  key: string;
  label: string;
  jobIds: number[];
  status: GraphNodeStatus;
  startedAt?: string;
  completedAt?: string;
}

/**
 * `stage` is a stable identifier, not display text: `level-<n>` (n from 1, the n-th level of the
 * workflow's needs) or `other` (jobs not in the workflow file). The UI translates it.
 */
export interface RunGraph {
  columns: Array<{ stage: string; nodes: GraphNode[] }>;
}

export interface DeployRunsState {
  projectId: string;
  /** Absent when the project has no GitHub repository. */
  repo?: { owner: string; repo: string };
  runs: DeployRun[];
  selected?: { runId: number; jobs: DeployJob[]; graph: RunGraph };
  error?: GitHubError;
  /** ISO time of the next poll. */
  nextPollAt: string;
}

/** `pending`: the job has not finished, GitHub has no log yet. `expired`: GitHub answered 410, the log is gone. `error`: any other failure (rate limit, permissions, no connection, network, 5xx). */
export type DeployJobLog =
  | { state: 'ready'; text: string }
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'error'; error: GitHubError };

export interface DeployAPI {
  startRuns: (projectId: string, selectedRunId?: number) => Promise<import('./common').IPCResult>;
  selectRun: (projectId: string, runId: number) => Promise<import('./common').IPCResult>;
  stopRuns: (projectId: string) => Promise<import('./common').IPCResult>;
  jobLog: (projectId: string, jobId: number) => Promise<import('./common').IPCResult<DeployJobLog>>;
  onRunsUpdate: (callback: (state: DeployRunsState) => void) => () => void;
  /** Runs setup (or joins the run already going for the project). */
  setUp: (projectId: string) => Promise<import('./common').IPCResult<DeploySetupState>>;
  state: (projectId: string) => Promise<import('./common').IPCResult<DeployEnvState>>;
  onSetupProgress: (callback: (progress: DeploySetupProgress) => void) => () => void;
  onPushResult: (callback: (result: DeployPushResult) => void) => () => void;
  /** Whether the readiness scan created this task: its spec is in the app's deploy ledger. False for unknown projects. */
  isDeployTask: (projectId: string, specId: string) => Promise<boolean>;
  /** Saved readiness result, whether a scan runs, the last scan error and the tasks by blocker key. */
  readinessState: (projectId: string) => Promise<import('./common').IPCResult<ReadinessState>>;
  /** Starts a scan (or joins the one running). `reason`: 'open' scans only when nothing is saved; default 'check-again'. */
  scanReadiness: (projectId: string, reason?: 'open' | 'check-again') => Promise<import('./common').IPCResult>;
  onReadinessUpdate: (callback: (update: { projectId: string; state: ReadinessState }) => void) => () => void;
  /** Saves a GitHub Actions secret on the project's repository. The value goes only to GitHub, sealed; it never comes back. */
  setSecret: (projectId: string, name: string, value: string) => Promise<import('./common').IPCResult<DeploySetSecretResult>>;
  /** The project's GitHub Actions secret names. */
  listSecrets: (projectId: string) => Promise<import('./common').IPCResult<DeployListSecretsResult>>;
  /** The task's CI state (raw value, never rejects in practice; unknown task or project: not-pushed). */
  previewState: (projectId: string, taskId: string) => Promise<TaskCiState>;
  /** A task's branch was pushed (success or failure): ask for `previewState` again. */
  onPreviewUpdate: (callback: (update: { projectId: string; taskId: string }) => void) => () => void;
}

/**
 * What CI setup has recorded for a project; each step is recorded as it completes (setup is idempotent).
 * Set up means `repo` is recorded (`isCiSetUp`). Old data may carry fields of the removed Vercel
 * deploy (vercel, database, services, pending*, vercelChoice, vercelTeamId): they are ignored.
 */
export interface DeployProjectSettings {
  /** True once the repository step finished (the old Deploy set it after its Vercel step). */
  enabled: boolean;
  /** `createdByApp`: the app created the repository (and pushes the main branch to it). */
  repo?: { owner: string; repo: string; createdByApp: boolean; public?: boolean };
  /** ISO time setup finished. */
  setUpAt?: string;
  /** Recorded just before the app asks GitHub to create the repo, so a re-run can adopt it instead of creating a second one. */
  pendingRepo?: { base: string; owner: string; at: string };
}

export type NeededFromYouKind =
  | 'github-sign-in'
  | 'github-app-install'
  | 'non-github-remote'
  | 'public-repo-warning';

/** Something only the owner can do (or should know) before setup can go on. `message` is English; the UI maps `kind` to i18n. */
export interface NeededFromYou {
  id: string;
  kind: NeededFromYouKind;
  message: string;
  actionUrl?: string;
}

export type DeploySetupStep = 'repo' | 'push' | 'done';

export type DeploySetupErrorKind = GitHubErrorKind | 'conflict' | 'invalid' | 'unknown';

export interface DeploySetupError {
  kind: DeploySetupErrorKind;
  /** Never contains a token or secret. */
  message: string;
}

export interface DeploySetupState {
  settings: DeployProjectSettings;
  needed: NeededFromYou[];
  /** The step setup reached (where it stopped, or `done`). */
  step?: DeploySetupStep;
  error?: DeploySetupError;
}

export interface DeploySetupProgress {
  projectId: string;
  step: DeploySetupStep;
}

/** The result of pushing the project's main branch to GitHub after a merge. */
export interface DeployPushResult {
  projectId: string;
  ok: boolean;
  error?: { kind: string; message: string };
  at: string;
}

/** What the Environment tab shows for a project (main keeps the last results of this app session). */
export interface DeployEnvState {
  /** The stored settings; null when deploy was never started for the project. */
  settings: DeployProjectSettings | null;
  setupRunning: boolean;
  lastSetup?: DeploySetupState;
  lastPush?: DeployPushResult;
}

// ============================================
// Readiness (what keeps the project's GitHub Actions CI from passing)
// ============================================

/** Old saved results may also hold `unsupported` blockers (the removed Vercel deploy): they are dropped on read. */
export type BlockerKind = 'code' | 'workflow';

export interface ReadinessBlocker {
  /** Stable across scans: `blockerKey(kind, subject)` */
  key: string;
  kind: BlockerKind;
  subject: string;
  title: string;
  detail: string;
}

/**
 * Something only the owner can do (names only, never values). `secret`: a GitHub Actions secret
 * the workflow reads that the repository lacks, named in `variable`. Old saved results say
 * `variable` for it: read as `secret`.
 */
export interface ReadinessOwnerItem {
  kind: 'secret' | 'other';
  variable?: string;
  message: string;
}

export interface ReadinessResult {
  scannedAt: string;
  commit?: string;
  blockers: ReadinessBlocker[];
  /** Only the removed Vercel Deploy saved it: such a result reads as absent; never written. */
  services?: unknown[];
  owner: ReadinessOwnerItem[];
  workflow: { path?: string; lastMainRun?: { conclusion: string; runId: number } };
}

/** Why a secret couldn't be saved or listed: a short kind, never a message (it could echo the value). */
export type DeploySecretErrorKind = GitHubErrorKind | 'conflict' | 'invalid' | 'not-set-up';

/** The result of saving a GitHub Actions secret. Never carries the value. */
export type DeploySetSecretResult = { ok: true } | { ok: false; kind: DeploySecretErrorKind };

/** The repository's GitHub Actions secret names (GitHub never returns values). */
export type DeployListSecretsResult = { ok: true; names: string[] } | { ok: false; kind: DeploySecretErrorKind };

/** What the Environment tab shows for readiness. */
export interface ReadinessState {
  result?: ReadinessResult;
  scanning: boolean;
  error?: string;
  /** Deploy tasks by blocker key */
  tasks: Record<string, { specId: string; status?: string }>;
  /** Keys Vibe Teamlead stopped fixing: fixed twice and the problem is still there (omitted when none) */
  gaveUp?: string[];
  /** The last failed run of a given-up run key (`run:<workflow path>`), by key */
  gaveUpLinks?: Record<string, string>;
}
