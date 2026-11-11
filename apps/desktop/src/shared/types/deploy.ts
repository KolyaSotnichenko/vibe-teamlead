/**
 * Deploy view types: GitHub Actions runs, jobs and deployments.
 * Shared across main, preload and renderer.
 */

export type DeployStatus = 'queued' | 'in_progress' | 'completed' | 'waiting';

export type GitHubErrorKind = 'no-connection' | 'permissions' | 'not-found' | 'rate-limit';

export interface GitHubError {
  kind: GitHubErrorKind;
  /** ISO time when the rate limit resets (rate-limit only). */
  resetAt?: string;
  message: string;
}

export interface DeployRun {
  id: number;
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
