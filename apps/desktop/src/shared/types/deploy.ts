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
}

/** The Vercel account the app is signed in to (Settings → Vercel). Never carries a token. */
export interface VercelStatus {
  connected: boolean;
  /** `browser`: signed in with `vercel login`; `token`: a pasted token. */
  source?: 'browser' | 'token';
  user?: { username: string; email?: string };
  teams?: Array<{ id: string; slug: string; name: string }>;
  /** Vercel could not be reached or answered with an error other than 401/403. */
  error?: string;
}

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
