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

export type DeployDeploymentState =
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'error'
  | 'inactive'
  | 'pending';

export interface DeployDeployment {
  environment: string;
  state: DeployDeploymentState;
  url?: string;
  logUrl?: string;
  createdAt: string;
}

export type GraphNodeStatus = 'queued' | 'running' | 'success' | 'failure' | 'skipped' | 'cancelled';

export interface GraphNode {
  key: string;
  label: string;
  jobIds: number[];
  status: GraphNodeStatus;
  startedAt?: string;
  completedAt?: string;
  /** Deployment nodes only: when the deployment was created (they have no start or duration) */
  deployedAt?: string;
  deploymentUrl?: string;
  logUrl?: string;
}

/**
 * `stage` is a stable identifier, not display text: `level-<n>` (n from 1, the n-th level of the
 * workflow's needs), `other` (jobs not in the workflow file) or `deploy`. The UI translates it.
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
  productionUrl?: string | null;
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
  /** Runs setup (or joins the run already going for the project). `vercelTeamId`: null = personal account; omitted = keep the stored choice. */
  setUp: (projectId: string, opts?: { vercelTeamId?: string | null }) => Promise<import('./common').IPCResult<DeploySetupState>>;
  state: (projectId: string) => Promise<import('./common').IPCResult<DeployEnvState>>;
  /** The owner's answer to `vercel-existing-project`; setup runs again with it. */
  chooseVercelProject: (
    projectId: string,
    choice: { useProjectId: string } | { createNew: true },
  ) => Promise<import('./common').IPCResult<DeploySetupState>>;
  setVariable: (projectId: string, input: DeployVariableInput) => Promise<import('./common').IPCResult<DeploySetVariableResult>>;
  listVariables: (projectId: string) => Promise<import('./common').IPCResult<DeployListVariablesResult>>;
  addDatabase: (projectId: string, opts?: { acceptTerms?: boolean }) => Promise<import('./common').IPCResult<DeployAddDatabaseResult>>;
  /** Cancels Add database while it downloads the Vercel CLI. */
  cancelDatabase: (projectId: string) => Promise<import('./common').IPCResult>;
  onDatabaseProgress: (callback: (progress: DeployDatabaseProgress) => void) => () => void;
  /** Adds Redis or Blob (same terms, progress and cancel flow as the database). */
  addService: (projectId: string, service: DeployServiceKind, opts?: { acceptTerms?: boolean }) => Promise<import('./common').IPCResult<DeployAddDatabaseResult>>;
  cancelService: (projectId: string, service: DeployServiceKind) => Promise<import('./common').IPCResult>;
  onSetupProgress: (callback: (progress: DeploySetupProgress) => void) => () => void;
  onPushResult: (callback: (result: DeployPushResult) => void) => () => void;
  /** Whether the readiness scan created this task: its spec is in the app's deploy ledger. False for unknown projects. */
  isDeployTask: (projectId: string, specId: string) => Promise<boolean>;
  /** Saved readiness result, whether a scan runs, the last scan error and the tasks by blocker key. */
  readinessState: (projectId: string) => Promise<import('./common').IPCResult<ReadinessState>>;
  /** Starts a scan (or joins the one running). `reason`: 'open' scans only when nothing is saved; default 'check-again'. */
  scanReadiness: (projectId: string, reason?: 'open' | 'check-again') => Promise<import('./common').IPCResult>;
  onReadinessUpdate: (callback: (update: { projectId: string; state: ReadinessState }) => void) => () => void;
}

/** The Vercel account the app is signed in to (Settings → Vercel). Never carries a token. */
export interface VercelStatus {
  connected: boolean;
  /** `browser`: signed in with `vercel login`; `token`: a pasted token. */
  source?: 'browser' | 'token';
  /** `id`: the account's id (the org of a project in the personal account). */
  user?: { id?: string; username: string; email?: string };
  teams?: Array<{ id: string; slug: string; name: string }>;
  /** `unreachable`: Vercel could not be reached; `unavailable`: it answered with an error other than 401/403. */
  error?: VercelStatusErrorKind;
}

export type VercelStatusErrorKind = 'unreachable' | 'unavailable';

/**
 * Why a Vercel sign-in, a pasted token or the CLI download failed (the IPC error is this code;
 * the renderer shows its own text). `cancelled` is not an error to show.
 */
export type VercelCredentialErrorKind =
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'download'
  | 'cli'
  | 'empty'
  | 'encryption-unavailable'
  | 'unknown';

/** Progress of a browser sign-in. */
export type VercelConnectState =
  | { phase: 'downloading'; percent: number }
  | { phase: 'waiting'; url: string; code?: string };

export interface VercelAPI {
  status: () => Promise<import('./common').IPCResult<VercelStatus>>;
  /** Resolves when the sign-in finishes, fails or is cancelled. */
  connect: () => Promise<import('./common').IPCResult<VercelStatus>>;
  cancelConnect: () => Promise<import('./common').IPCResult>;
  setToken: (token: string) => Promise<import('./common').IPCResult<VercelStatus>>;
  disconnect: () => Promise<import('./common').IPCResult<VercelStatus>>;
  onConnectState: (callback: (state: VercelConnectState) => void) => () => void;
}

export type VercelErrorKind =
  | 'no-connection'
  | 'forbidden'
  | 'not-found'
  | 'git-not-connected'
  | 'conflict'
  | 'bad-request'
  | 'rate-limit'
  | 'unavailable';

export interface VercelError {
  kind: VercelErrorKind;
  /** Never contains the token or an env value. */
  message: string;
  /** ISO time when the rate limit resets (rate-limit only). */
  resetAt?: string;
  /** Where the user grants the Vercel GitHub App access (git-not-connected only). */
  actionUrl?: string;
}

export type VercelEnvTarget = 'production' | 'preview' | 'development';

/** What the Deploy tab has set up for a project; each step is recorded as it completes (setup is idempotent). */
export interface DeployProjectSettings {
  enabled: boolean;
  /** `createdByApp`: the app created the repository (and pushes the main branch to it). */
  repo?: { owner: string; repo: string; createdByApp: boolean; public?: boolean };
  vercel?: { projectId: string; projectName: string; teamId?: string };
  database?: { provider: 'neon'; addedAt: string };
  /** Recorded just before the database is added, so a retry after a crash or timeout finds the resource instead of adding a second one. */
  pendingDatabase?: { name: string; at: string };
  /** Redis and Blob added from Vercel (Neon keeps `database`). */
  services?: Partial<Record<DeployServiceKind, { addedAt: string }>>;
  /** Like `pendingDatabase`, per service. */
  pendingServices?: Partial<Record<DeployServiceKind, { name: string; at: string }>>;
  /** ISO time setup finished. */
  setUpAt?: string;
  /** Recorded just before the app asks GitHub to create the repo, so a re-run can adopt it instead of creating a second one. */
  pendingRepo?: { base: string; owner: string; at: string };
  /** Recorded just before the app asks Vercel to create the project (same purpose). */
  pendingVercel?: { name: string; at: string; teamId?: string };
  /** The owner's answer to `vercel-existing-project` (set by the UI): use that project, or create a new one anyway. */
  vercelChoice?: { useProjectId?: string; createNew?: boolean };
  /** The Vercel team the owner picked before setup (absent: the personal account). A team already recorded in `vercel` wins. */
  vercelTeamId?: string;
}

/** Marketplace/Vercel services other than the Neon database. */
export type DeployServiceKind = 'redis' | 'blob';

export type NeededFromYouKind =
  | 'vercel-sign-in'
  | 'github-sign-in'
  | 'github-app-install'
  | 'vercel-git-access'
  | 'vercel-existing-project'
  | 'non-github-remote'
  | 'public-repo-warning'
  | 'variable'
  | 'database-terms'
  | 'database-dashboard';

/** Something only the owner can do (or should know) before setup can go on. `message` is English; the UI maps `kind` to i18n. */
export interface NeededFromYou {
  id: string;
  kind: NeededFromYouKind;
  message: string;
  actionUrl?: string;
  variable?: string;
  /** vercel-existing-project: the Vercel projects already linked to the repository. */
  projects?: Array<{ id: string; name: string }>;
  /** database-terms: the integration the terms are for, and the policy links to show (https only). */
  integration?: string;
  policyLinks?: Array<{ name: string; url: string; host: string }>;
}

export type DeploySetupStep = 'repo' | 'push' | 'vercel' | 'done';

export type DeploySetupErrorKind = GitHubErrorKind | VercelErrorKind | 'conflict' | 'invalid' | 'unknown';

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

/** A failure on one side (Vercel or GitHub) of saving a variable. */
export interface DeploySideError {
  kind: string;
  message: string;
}

export type DeployVariableTarget = 'production' | 'preview';

export interface DeployVariableInput {
  name: string;
  value: string;
  targets: DeployVariableTarget[];
  alsoGitHubSecret: boolean;
}

export type DeploySetVariableResult =
  | { ok: true; vercel: 'ok'; github: 'ok' | 'skipped' }
  | { ok: false; kind: 'not-set-up'; message: string }
  | { ok: false; vercel: 'ok' | 'skipped' | DeploySideError; github: 'ok' | 'skipped' | DeploySideError };

export interface DeployVariable {
  name: string;
  targets: string[];
  inGitHub: boolean;
}

export type DeployListVariablesResult =
  | { ok: true; variables: DeployVariable[]; githubUnavailable?: DeploySideError }
  | { ok: false; kind: string; message: string };

export type DeployDatabaseErrorKind = 'not-set-up' | 'auth' | 'cli' | 'timeout' | 'cancelled' | 'conflict' | 'saved-failed' | 'unknown';

/** Add database is downloading the Vercel CLI (pasted-token accounts get it on the first Add database); no `download` = not downloading. */
export interface DeployDatabaseProgress {
  projectId: string;
  download?: { percent: number };
  /** Set when the progress is for Redis or Blob. */
  service?: DeployServiceKind;
}

export type DeployAddDatabaseResult =
  | { ok: true }
  | { ok: false; needed: NeededFromYou }
  | { ok: false; error: { kind: DeployDatabaseErrorKind; message: string } };

/** What the Environment tab shows for a project (main keeps the last results of this app session). */
export interface DeployEnvState {
  /** The stored settings; null when deploy was never started for the project. */
  settings: DeployProjectSettings | null;
  setupRunning: boolean;
  lastSetup?: DeploySetupState;
  databaseRunning: boolean;
  /** Add database is downloading the Vercel CLI first. */
  databaseDownload?: { percent: number };
  lastDatabase?: DeployAddDatabaseResult;
  /** Redis/Blob adds running now, their CLI download progress and last results. */
  servicesRunning?: DeployServiceKind[];
  serviceDownload?: Partial<Record<DeployServiceKind, { percent: number }>>;
  lastServices?: Partial<Record<DeployServiceKind, DeployAddDatabaseResult>>;
  lastPush?: DeployPushResult;
}

// ============================================
// Readiness (what stands between the project and a first deploy)
// ============================================

export type BlockerKind = 'code' | 'workflow' | 'unsupported';

export interface ReadinessBlocker {
  /** Stable across scans: `blockerKey(kind, subject)` */
  key: string;
  kind: BlockerKind;
  subject: string;
  title: string;
  detail: string;
}

export type ServiceKind = 'postgres' | 'redis' | 'blob' | 'other';

export interface ReadinessService {
  kind: ServiceKind;
  name: string;
  /** Vercel can provide it (a Marketplace database, Blob) */
  managed: boolean;
  reason?: string;
}

/** Something only the owner can do (names only, never values). */
export interface ReadinessOwnerItem {
  kind: 'variable' | 'other';
  variable?: string;
  message: string;
}

export interface ReadinessResult {
  scannedAt: string;
  commit?: string;
  blockers: ReadinessBlocker[];
  services: ReadinessService[];
  owner: ReadinessOwnerItem[];
  workflow: { path?: string; lastMainRun?: { conclusion: string; runId: number } };
}

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
