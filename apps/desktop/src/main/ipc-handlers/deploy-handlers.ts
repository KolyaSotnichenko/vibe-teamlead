/**
 * Deploy IPC: start, select and stop the runs poller, read a job's log; set up deploy
 * (one run per project at a time, a second call joins it), variables, the database and
 * the state the Environment tab shows. Errors travel as data; values and tokens never
 * reach the renderer or a message.
 */
import { type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, Project } from '../../shared/types';
import type {
  DeployAddDatabaseResult,
  DeployEnvState,
  DeployJobLog,
  DeployListVariablesResult,
  DeployProjectSettings,
  DeploySetupState,
  DeploySetVariableResult,
  DeployVariableInput,
} from '../../shared/types/deploy';
import { addDatabase } from '../deploy/database';
import { createActionsClient, resolveRepo } from '../deploy/github-actions';
import { githubFetcher } from '../deploy/github-fetcher';
import { listRepoSecretNames, setRepoSecret } from '../deploy/github-write';
import { lastPushResult } from '../deploy/push-after-merge';
import { createRunsPoller, fetchJobLog } from '../deploy/runs-poller';
import { createSetupDeps, saveDeployPatch, setUpDeploy } from '../deploy/setup';
import { listDeployVariables, setDeployVariable, type VariablesDeps } from '../deploy/variables';
import { createVercelClient, defaultVercelFetcher } from '../deploy/vercel-api';
import { getVercelToken, vercelCliPaths, vercelStatus } from '../deploy/vercel-credential';
import { projectStore } from '../project-store';
import { safeSendToRenderer } from './utils';

const TEAM_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROJECT_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const MAX_VALUE = 64 * 1024;

const deploySettings = (project: Project): DeployProjectSettings => project.settings.deploy ?? { enabled: false };

/** A well-formed variable input with only the known fields, or null. */
function variableInput(raw: unknown): DeployVariableInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length > 256) return null;
  if (typeof r.value !== 'string' || r.value.length > MAX_VALUE) return null;
  if (!Array.isArray(r.targets) || !r.targets.every((t) => t === 'production' || t === 'preview')) return null;
  if (typeof r.alsoGitHubSecret !== 'boolean') return null;
  return { name: r.name, value: r.value, targets: [...new Set(r.targets)] as DeployVariableInput['targets'], alsoGitHubSecret: r.alsoGitHubSecret };
}

function variablesDeps(): VariablesDeps {
  return {
    vercelClient: (scope) => createVercelClient(defaultVercelFetcher, scope, () => getVercelToken()),
    setRepoSecret: (owner, repo, name, value) => setRepoSecret(owner, repo, name, value),
    listRepoSecretNames: (owner, repo) => listRepoSecretNames(owner, repo),
  };
}

export function registerDeployHandlers(getMainWindow: () => BrowserWindow | null): void {
  const client = createActionsClient(githubFetcher);
  const poller = createRunsPoller({
    client,
    resolveRepo,
    emit: (state) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_RUNS_UPDATE, state),
  });

  // The renderer cannot stop polling when it reloads or goes away, so main does.
  const watched = new WeakSet<object>();
  const watchWindow = () => {
    const contents = getMainWindow()?.webContents;
    if (!contents || watched.has(contents)) return;
    watched.add(contents);
    contents.on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) poller.stopAll();
    });
    contents.once('destroyed', () => poller.stopAll());
  };

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_RUNS_START,
    async (_event, projectId: string, selectedRunId?: number): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      watchWindow();
      poller.start(project, selectedRunId);
      return { success: true };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_RUNS_SELECT,
    async (_event, projectId: string, runId: number): Promise<IPCResult> => {
      poller.select(projectId, runId);
      return { success: true };
    }
  );

  ipcMain.handle(IPC_CHANNELS.DEPLOY_RUNS_STOP, async (_event, projectId: string): Promise<IPCResult> => {
    poller.stop(projectId);
    return { success: true };
  });

  // --- Set up deploy ---------------------------------------------------------------------------

  const setupRuns = new Map<string, Promise<DeploySetupState>>();
  const lastSetup = new Map<string, DeploySetupState>();

  /** Starts setup for a project, or joins the run already going (the team option of a joining call is ignored). */
  const runSetup = (project: Project, before?: () => void): Promise<DeploySetupState> => {
    const running = setupRuns.get(project.id);
    if (running) return running;
    const run = (async () => {
      before?.();
      const fresh = projectStore.getProject(project.id) ?? project;
      const deps = await createSetupDeps(fresh, {
        vercelTeamId: fresh.settings.deploy?.vercelTeamId,
        onProgress: (step) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_SETUP_PROGRESS, { projectId: project.id, step }),
      });
      return setUpDeploy(fresh, deps);
    })()
      .catch((): DeploySetupState => ({
        settings: deploySettings(projectStore.getProject(project.id) ?? project),
        needed: [],
        error: { kind: 'unknown', message: 'Setup stopped unexpectedly. Try again.' },
      }))
      .then((state) => {
        lastSetup.set(project.id, state);
        return state;
      })
      .finally(() => setupRuns.delete(project.id));
    setupRuns.set(project.id, run);
    return run;
  };

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_SETUP,
    async (_event, projectId: string, opts?: { vercelTeamId?: unknown }): Promise<IPCResult<DeploySetupState>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const hasTeam = !!opts && typeof opts === 'object' && 'vercelTeamId' in opts;
      const team = hasTeam ? opts.vercelTeamId : undefined;
      if (hasTeam && team !== null && (typeof team !== 'string' || !TEAM_ID.test(team))) {
        return { success: false, error: 'Invalid Vercel team' };
      }
      const before = hasTeam
        ? () => saveDeployPatch(projectStore, projectId, { vercelTeamId: typeof team === 'string' ? team : undefined })
        : undefined;
      return { success: true, data: await runSetup(project, before) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT,
    async (_event, projectId: string, choice: unknown): Promise<IPCResult<DeploySetupState>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const c = (typeof choice === 'object' && choice !== null ? choice : {}) as Record<string, unknown>;
      let vercelChoice: DeployProjectSettings['vercelChoice'];
      if (typeof c.useProjectId === 'string' && PROJECT_ID.test(c.useProjectId)) vercelChoice = { useProjectId: c.useProjectId };
      else if (c.createNew === true) vercelChoice = { createNew: true };
      else return { success: false, error: 'Invalid choice' };
      if (setupRuns.has(projectId)) return { success: false, error: 'busy' };
      return {
        success: true,
        data: await runSetup(project, () => saveDeployPatch(projectStore, projectId, { vercelChoice })),
      };
    }
  );

  // --- Database --------------------------------------------------------------------------------

  const databaseRuns = new Map<string, Promise<DeployAddDatabaseResult>>();
  const lastDatabase = new Map<string, DeployAddDatabaseResult>();

  const runDatabase = async (project: Project, acceptTerms: boolean): Promise<DeployAddDatabaseResult> => {
    const vercel = project.settings.deploy?.vercel;
    if (!vercel?.projectId) return { ok: false, error: { kind: 'not-set-up', message: 'This project is not set up on Vercel yet.' } };
    let paths: { binary: string; configDir: string };
    try {
      paths = await vercelCliPaths();
    } catch {
      return { ok: false, error: { kind: 'cli', message: 'The Vercel CLI could not be prepared.' } };
    }
    // A personal-account project's org is the user: only then is the account asked for.
    const userId = vercel.teamId ? undefined : (await vercelStatus()).user?.id;
    return addDatabase(
      project,
      {
        binary: paths.binary,
        configDir: paths.configDir,
        getToken: () => getVercelToken(),
        loadProject: () => projectStore.getProject(project.id),
        saveSettings: (patch) => saveDeployPatch(projectStore, project.id, patch),
        ...(userId ? { userId } : {}),
      },
      { acceptTerms }
    );
  };

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_ADD_DATABASE,
    async (_event, projectId: string, opts?: { acceptTerms?: unknown }): Promise<IPCResult<DeployAddDatabaseResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      let run = databaseRuns.get(projectId);
      if (!run) {
        run = runDatabase(project, opts?.acceptTerms === true)
          .catch((): DeployAddDatabaseResult => ({ ok: false, error: { kind: 'unknown', message: 'Adding the database failed.' } }))
          .then((result) => {
            lastDatabase.set(projectId, result);
            return result;
          })
          .finally(() => databaseRuns.delete(projectId));
        databaseRuns.set(projectId, run);
      }
      return { success: true, data: await run };
    }
  );

  // --- Variables -------------------------------------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_SET_VARIABLE,
    async (_event, projectId: string, raw: unknown): Promise<IPCResult<DeploySetVariableResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const input = variableInput(raw);
      if (!input) return { success: false, error: 'Invalid variable' };
      try {
        return { success: true, data: await setDeployVariable(deploySettings(project), input, variablesDeps()) };
      } catch {
        return { success: false, error: 'The variable could not be saved.' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_LIST_VARIABLES,
    async (_event, projectId: string): Promise<IPCResult<DeployListVariablesResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        return { success: true, data: await listDeployVariables(deploySettings(project), variablesDeps()) };
      } catch {
        return { success: false, error: 'The variables could not be listed.' };
      }
    }
  );

  // --- State -----------------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.DEPLOY_STATE, async (_event, projectId: string): Promise<IPCResult<DeployEnvState>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const setup = lastSetup.get(projectId);
    const database = lastDatabase.get(projectId);
    const push = lastPushResult(projectId);
    return {
      success: true,
      data: {
        settings: project.settings.deploy ?? null,
        setupRunning: setupRuns.has(projectId),
        databaseRunning: databaseRuns.has(projectId),
        ...(setup ? { lastSetup: setup } : {}),
        ...(database ? { lastDatabase: database } : {}),
        ...(push ? { lastPush: push } : {}),
      },
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_JOB_LOG,
    async (_event, projectId: string, jobId: number): Promise<IPCResult<DeployJobLog>> => {
      // The repo the poller resolved for the project on screen; no second git call.
      const repo = poller.repoFor(projectId);
      if (!repo) return { success: false, error: 'No GitHub repository' };
      return { success: true, data: await fetchJobLog(client, repo, jobId) };
    }
  );
}
