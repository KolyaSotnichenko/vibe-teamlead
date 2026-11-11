/**
 * Deploy variables and secrets: save a variable to the Vercel project (sensitive) and,
 * when asked, as a GitHub Actions secret; list names only.
 *
 * Never throws. The value goes only into the two API calls; results and messages carry
 * a kind and a fixed or classified message, never the value (messages that come from
 * dependencies are replaced unless they are typed Vercel/GitHub errors, which never hold it).
 */
import type {
  DeployListVariablesResult,
  DeployProjectSettings,
  DeploySetVariableResult,
  DeploySideError,
  VercelError,
} from '../../shared/types/deploy';
import type { GitHubWriteError } from './github-write';
import { isVercelError, type VercelClient } from './vercel-api';

type Target = 'production' | 'preview';
export type SideError = DeploySideError;

export interface VariablesDeps {
  vercelClient: (scope: { teamId?: string }) => Pick<VercelClient, 'upsertEnv' | 'listEnvNames'>;
  setRepoSecret: (owner: string, repo: string, name: string, value: string) => Promise<void>;
  listRepoSecretNames: (owner: string, repo: string) => Promise<string[]>;
}

export type SetVariableResult = DeploySetVariableResult;
export type ListVariablesResult = DeployListVariablesResult;

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const NOT_SET_UP = 'Set up deployment for this project first (repository and Vercel project).';

function isGitHubError(e: unknown): e is GitHubWriteError {
  return e instanceof Error && e.name === 'GitHubWriteError' && typeof (e as GitHubWriteError).kind === 'string';
}
function vercelSide(e: unknown): SideError {
  if (isVercelError(e)) return { kind: (e as VercelError).kind, message: e.message };
  return { kind: 'unavailable', message: 'Vercel could not save the variable.' };
}
function githubSide(e: unknown): SideError {
  if (isGitHubError(e)) return { kind: e.kind, message: e.message };
  return { kind: 'unavailable', message: 'GitHub could not save the secret.' };
}

export async function setDeployVariable(
  project: DeployProjectSettings,
  input: { name: string; value: string; targets: Target[]; alsoGitHubSecret: boolean },
  deps: VariablesDeps,
): Promise<SetVariableResult> {
  if (!project.vercel || !project.repo) return { ok: false, kind: 'not-set-up', message: NOT_SET_UP };
  const invalid = (message: string): SetVariableResult => ({ ok: false, vercel: { kind: 'invalid', message }, github: 'skipped' });
  if (!NAME.test(input.name)) return invalid('Names use capital letters, digits and underscores, and do not start with a digit.');
  if (input.targets.length === 0 || input.targets.some((t) => t !== 'production' && t !== 'preview')) {
    return invalid('Choose Production, Preview or both.');
  }
  if (input.alsoGitHubSecret && input.name.startsWith('GITHUB_')) {
    return { ok: false, vercel: 'skipped', github: { kind: 'invalid', message: 'GitHub secret names cannot start with GITHUB_.' } };
  }
  const { projectId, teamId } = project.vercel;
  try {
    await deps.vercelClient(teamId ? { teamId } : {}).upsertEnv(projectId, {
      key: input.name,
      value: input.value,
      targets: input.targets,
      sensitive: true,
    });
  } catch (e) {
    return { ok: false, vercel: vercelSide(e), github: 'skipped' };
  }
  if (!input.alsoGitHubSecret) return { ok: true, vercel: 'ok', github: 'skipped' };
  try {
    await deps.setRepoSecret(project.repo.owner, project.repo.repo, input.name, input.value);
  } catch (e) {
    return { ok: false, vercel: 'ok', github: githubSide(e) };
  }
  return { ok: true, vercel: 'ok', github: 'ok' };
}

export async function listDeployVariables(project: DeployProjectSettings, deps: VariablesDeps): Promise<ListVariablesResult> {
  if (!project.vercel || !project.repo) return { ok: false, kind: 'not-set-up', message: NOT_SET_UP };
  const { projectId, teamId } = project.vercel;
  let envs: Array<{ key: string; targets: string[] }>;
  try {
    envs = await deps.vercelClient(teamId ? { teamId } : {}).listEnvNames(projectId);
  } catch (e) {
    const s = vercelSide(e);
    return { ok: false, kind: s.kind, message: isVercelError(e) ? s.message : 'Vercel could not list the variables.' };
  }
  let secrets = new Set<string>();
  let githubUnavailable: SideError | undefined;
  try {
    secrets = new Set(await deps.listRepoSecretNames(project.repo.owner, project.repo.repo));
  } catch (e) {
    githubUnavailable = githubSide(e);
  }
  return {
    ok: true,
    variables: envs.map((v) => ({ name: v.key, targets: v.targets, inGitHub: secrets.has(v.key) })),
    ...(githubUnavailable ? { githubUnavailable } : {}),
  };
}
