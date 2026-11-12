/**
 * Deploy IPC: start, select and stop the runs poller, read a job's log; set up deploy
 * (one run per project at a time, a second call joins it), variables, the database and
 * the state the Environment tab shows. Errors travel as data; values and tokens never
 * reach the renderer or a message.
 */
import { execFile } from 'node:child_process';

import { type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, Project } from '../../shared/types';
import { resolveDefaultTaskModels } from '../../shared/utils/task-models';
import type {
  DeployAddDatabaseResult,
  DeployEnvState,
  DeployJobLog,
  DeployListVariablesResult,
  DeployProjectSettings,
  DeploySetupState,
  DeploySetVariableResult,
  DeployVariableInput,
  ReadinessState,
} from '../../shared/types/deploy';
import type { AgentManager } from '../agent';
import { runReadinessScan, type ScanInput } from '../ai/runners/deploy-readiness';
import { addDatabase } from '../deploy/database';
import { createActionsClient, resolveRepo } from '../deploy/github-actions';
import { githubFetcher } from '../deploy/github-fetcher';
import { listRepoSecretNames, setRepoSecret } from '../deploy/github-write';
import { createReadiness } from '../deploy/readiness';
import { setReadiness } from '../deploy/readiness-instance';
import { lastPushResult } from '../deploy/push-after-merge';
import { createRunsPoller, fetchJobLog } from '../deploy/runs-poller';
import { createSetupDeps, readGitInfo, saveDeployPatch, setUpDeploy } from '../deploy/setup';
import { listDeployVariables, setDeployVariable, type VariablesDeps } from '../deploy/variables';
import { createVercelClient, defaultVercelFetcher } from '../deploy/vercel-api';
import { getVercelToken, vercelCliPaths, vercelStatus } from '../deploy/vercel-credential';
import { getToolPath } from '../cli-tool-manager';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import { getIsolatedGitEnv } from '../utils/git-isolation';
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

const READINESS_FAILED_RUNS = 20;

/** HEAD of the project's checkout; undefined on any failure. */
function headCommit(projectPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      getToolPath('git'),
      ['rev-parse', 'HEAD'],
      { cwd: projectPath, env: getIsolatedGitEnv() as NodeJS.ProcessEnv, timeout: 10_000, encoding: 'utf-8' },
      (err, stdout) => {
        const sha = String(stdout ?? '').trim();
        resolve(!err && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined);
      },
    );
  });
}

export function registerDeployHandlers(getMainWindow: () => BrowserWindow | null, agentManager?: AgentManager): void {
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

  // --- Readiness -------------------------------------------------------------------------------

  const mainBranchOf = async (project: Project): Promise<string | undefined> => {
    if (project.settings.mainBranch) return project.settings.mainBranch;
    const names = (await readGitInfo(project.path))?.branches ?? [];
    return names.includes('main') ? 'main' : names.includes('master') ? 'master' : undefined;
  };

  const readiness = createReadiness({
    scan: (input) => runReadinessScan(input),
    lastMainRun: async (project): Promise<ScanInput['lastMainRun']> => {
      try {
        const repo = await resolveRepo(project);
        const main = await mainBranchOf(project);
        if (!repo || !main) return undefined;
        const runs = await client.runs(repo.owner, repo.repo, READINESS_FAILED_RUNS);
        const run = runs
          .filter((r) => r.branch === main && r.status === 'completed' && r.conclusion)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (!run?.conclusion) return undefined;
        const jobs = run.conclusion === 'success' ? [] : await client.jobs(repo.owner, repo.repo, run.id);
        return {
          conclusion: run.conclusion,
          runId: run.id,
          failedJobs: jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name),
          ...(run.workflowPath ? { workflowPath: run.workflowPath } : {}),
        };
      } catch {
        return undefined;
      }
    },
    variableNames: async (project) => {
      const listed = await listDeployVariables(deploySettings(project), variablesDeps());
      return listed.ok ? listed.variables.map((v) => v.name) : [];
    },
    headCommit,
    tasks: {
      getTasks: (projectId) => projectStore.getTasks(projectId),
      // Lazy: the task handlers are heavy and import much of the app
      createTask: async (project, title, description, metadata) =>
        (await import('./task/crud-handlers')).createTaskInProject(project, title, description, metadata),
      startTask: async (id) => {
        if (!agentManager) return;
        await (await import('./task/execution-handlers')).startTask(agentManager, getMainWindow, id);
      },
      defaultModels: () => resolveDefaultTaskModels(readSettingsFile() as never),
    },
    // The team recorded for the project is used by setup itself (runSetup reads settings.deploy.vercelTeamId)
    setUp: (project) => runSetup(project),
    canAutoSetUp: async (project) => {
      const fresh = projectStore.getProject(project.id) ?? project;
      if (fresh.settings.deploy?.vercelTeamId) return true;
      // An account with teams and no recorded choice: the owner picks the team, setup waits for them
      return !((await vercelStatus()).teams?.length);
    },
    emit: (projectId, state) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_READINESS_UPDATE, { projectId, state }),
  });
  setReadiness(readiness);

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_READINESS_STATE,
    async (_event, projectId: string): Promise<IPCResult<ReadinessState>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      return { success: true, data: readiness.state(project) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_READINESS_SCAN,
    async (_event, projectId: string, reason?: unknown): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      // Not awaited: the renderer follows progress through the update event
      void readiness.scan(project, reason === 'open' ? 'open' : 'check-again');
      return { success: true };
    }
  );

  // --- Database --------------------------------------------------------------------------------

  const databaseRuns = new Map<string, Promise<DeployAddDatabaseResult>>();
  const lastDatabase = new Map<string, DeployAddDatabaseResult>();
  const databaseCancel = new Map<string, AbortController>();
  const databaseDownload = new Map<string, number>();

  /** The CLI (downloaded here, with progress and Cancel, when a pasted-token account has none yet). */
  const databaseCli = async (projectId: string): Promise<{ binary: string; configDir: string } | DeployAddDatabaseResult> => {
    const controller = new AbortController();
    databaseCancel.set(projectId, controller);
    const send = (percent?: number) =>
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_DATABASE_PROGRESS, { projectId, ...(percent === undefined ? {} : { download: { percent } }) });
    try {
      return await vercelCliPaths({
        signal: controller.signal,
        onProgress: (received, total) => {
          const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
          if (databaseDownload.get(projectId) === percent) return;
          databaseDownload.set(projectId, percent);
          send(percent);
        },
      });
    } catch (error) {
      const kind = controller.signal.aborted ? 'cancelled' : (error as { kind?: unknown })?.kind;
      if (kind === 'cancelled') return { ok: false, error: { kind: 'cancelled', message: 'The Vercel CLI download was cancelled.' } };
      if (kind === 'timeout') return { ok: false, error: { kind: 'timeout', message: 'The Vercel CLI download took too long.' } };
      return { ok: false, error: { kind: 'cli', message: 'The Vercel CLI could not be prepared.' } };
    } finally {
      if (databaseCancel.get(projectId) === controller) databaseCancel.delete(projectId);
      if (databaseDownload.delete(projectId)) send();
    }
  };

  const runDatabase = async (project: Project, acceptTerms: boolean): Promise<DeployAddDatabaseResult> => {
    const vercel = project.settings.deploy?.vercel;
    if (!vercel?.projectId) return { ok: false, error: { kind: 'not-set-up', message: 'This project is not set up on Vercel yet.' } };
    const paths = await databaseCli(project.id);
    if ('ok' in paths) return paths;
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

  ipcMain.handle(IPC_CHANNELS.DEPLOY_CANCEL_DATABASE, async (_event, projectId: string): Promise<IPCResult> => {
    databaseCancel.get(projectId)?.abort();
    return { success: true };
  });

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
        ...(databaseDownload.has(projectId) ? { databaseDownload: { percent: databaseDownload.get(projectId) as number } } : {}),
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
