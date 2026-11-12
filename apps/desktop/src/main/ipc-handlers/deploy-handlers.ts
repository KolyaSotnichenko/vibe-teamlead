/**
 * Deploy (CI) IPC: start, select and stop the runs poller, read a job's log; set up CI
 * (one run per project at a time, a second call joins it), readiness, GitHub Actions secrets
 * and the state the Environment tab shows. Errors travel as data; values and tokens never
 * reach the renderer or a message. At start, the old Vercel deploy's userData leftovers are
 * removed once.
 */
import { execFile } from 'node:child_process';

import { app, type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, Project } from '../../shared/types';
import { resolveDefaultTaskModels } from '../../shared/utils/task-models';
import type {
  DeployEnvState,
  DeployJobLog,
  DeployListSecretsResult,
  DeployProjectSettings,
  DeploySecretErrorKind,
  DeploySetSecretResult,
  DeploySetupState,
  ReadinessState,
  TaskCiState,
} from '../../shared/types/deploy';
import type { AgentManager } from '../agent';
import { runReadinessScan } from '../ai/runners/deploy-readiness';
import { cleanupVercelLeftovers, isCiSetUp } from '../deploy/ci-setup';
import { createActionsClient, resolveRepo } from '../deploy/github-actions';
import { githubFetcher } from '../deploy/github-fetcher';
import { isValidSecretName, listRepoSecretNames, setRepoSecret } from '../deploy/github-write';
import { type DeployTaskDeps, isDeployTask } from '../deploy/deploy-tasks';
import { previewState } from '../deploy/preview-state';
import { createReadiness } from '../deploy/readiness';
import { setMainRunDeps, setReadiness } from '../deploy/readiness-instance';
import { findLastMainRun, handleMainRuns, type MainRunDeps } from '../deploy/main-runs';
import { lastPushResult, resolveMainBranch } from '../deploy/push-after-merge';
import { createRunsPoller, fetchJobLog } from '../deploy/runs-poller';
import { createSetupDeps, setUpDeploy } from '../deploy/setup';
import { getToolPath } from '../cli-tool-manager';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { safeSendToRenderer } from './utils';

const deploySettings = (project: Project): DeployProjectSettings => project.settings.deploy ?? { enabled: false };

/** GitHub's limit for a secret value, in bytes */
const MAX_SECRET_BYTES = 48 * 1024;

/** The kinds a GitHub write error carries; anything else (or a free-text message) becomes `unavailable`. */
const SECRET_ERROR_KINDS: ReadonlySet<string> = new Set(['no-connection', 'permissions', 'not-found', 'rate-limit', 'unavailable', 'conflict', 'invalid']);

/** A GitHub failure as its kind only: the message never crosses IPC (it could echo a URL or the value). */
function secretErrorKind(e: unknown): DeploySecretErrorKind {
  const kind = e instanceof Error && e.name === 'GitHubWriteError' ? (e as { kind?: unknown }).kind : undefined;
  return typeof kind === 'string' && SECRET_ERROR_KINDS.has(kind) ? (kind as DeploySecretErrorKind) : 'unavailable';
}

/** The repository CI secrets go to: the recorded one, once CI is set up. */
const secretsRepo = (project: Project) => (isCiSetUp(project) ? deploySettings(project).repo : undefined);

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
  // What the old Vercel deploy left in userData (credential, CLI, link folders): removed once, best effort
  try {
    void cleanupVercelLeftovers(app.getPath('userData')).catch(() => undefined);
  } catch {
    // no user data path: nothing to clean
  }

  // Tasks the readiness scan and failing runs create
  const taskDeps: DeployTaskDeps = {
    getTasks: (projectId) => projectStore.getTasks(projectId),
    // Lazy: the task handlers are heavy and import much of the app
    createTask: async (project, title, description, metadata) => {
      const task = await (await import('./task/crud-handlers')).createTaskInProject(project, title, description, metadata);
      // The next open-task check must see it (the ledger also treats a task under 60 s old as open)
      projectStore.invalidateTasksCache(project.id);
      return task;
    },
    startTask: async (id) => {
      if (!agentManager) return;
      await (await import('./task/execution-handlers')).startTask(agentManager, getMainWindow, id);
    },
    // Blocker tasks wait for a free slot (the project's parallel-task limit) like any task
    queueTask: async (id) => {
      await (await import('./task/queue-task')).queueTask(getMainWindow, id);
    },
    defaultModels: () => resolveDefaultTaskModels(readSettingsFile() as never),
  };
  const mainRunDeps: MainRunDeps = { client, resolveRepo, tasks: taskDeps };
  setMainRunDeps(mainRunDeps);
  const poller = createRunsPoller({
    client,
    resolveRepo,
    emit: (state) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_RUNS_UPDATE, state),
    mainBranch: (project) => resolveMainBranch(project),
    handleMainRuns: (project, runs) => handleMainRuns(projectStore.getProject(project.id) ?? project, runs, mainRunDeps),
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

  /** Starts setup for a project, or joins the run already going. */
  const runSetup = (project: Project): Promise<DeploySetupState> => {
    const running = setupRuns.get(project.id);
    if (running) return running;
    const run = (async () => {
      const fresh = projectStore.getProject(project.id) ?? project;
      const deps = await createSetupDeps(fresh, {
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

  ipcMain.handle(IPC_CHANNELS.DEPLOY_SETUP, async (_event, projectId: string): Promise<IPCResult<DeploySetupState>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    return { success: true, data: await runSetup(project) };
  });

  // --- Readiness -------------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.DEPLOY_IS_DEPLOY_TASK, (_event, projectId: string, specId: string): boolean => {
    const project = projectStore.getProject(projectId);
    return !!project && isDeployTask(project.path, specId);
  });

  const readiness = createReadiness({
    scan: (input) => runReadinessScan(input),
    // Own pushes to main only (a fork's pull request can carry a branch named main)
    lastMainRun: (project) => findLastMainRun(project, mainRunDeps),
    // Names only: the GitHub Actions secrets of the recorded repository (none before setup)
    secretNames: async (project) => {
      const repo = secretsRepo(project);
      return repo ? listRepoSecretNames(repo.owner, repo.repo) : [];
    },
    headCommit,
    tasks: taskDeps,
    emit: (projectId, state) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_READINESS_UPDATE, { projectId, state }),
    loadProject: (projectId) => projectStore.getProject(projectId),
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

  // --- Secrets (GitHub Actions) ----------------------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_SET_SECRET,
    async (_event, projectId: string, name: unknown, value: unknown): Promise<IPCResult<DeploySetSecretResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      // The value goes only into the sealed GitHub call: never logged, stored or returned
      if (typeof name !== 'string' || !isValidSecretName(name)) return { success: true, data: { ok: false, kind: 'invalid' } };
      if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) return { success: true, data: { ok: false, kind: 'invalid' } };
      const repo = secretsRepo(project);
      if (!repo) return { success: true, data: { ok: false, kind: 'not-set-up' } };
      try {
        await setRepoSecret(repo.owner, repo.repo, name, value);
        return { success: true, data: { ok: true } };
      } catch (e) {
        return { success: true, data: { ok: false, kind: secretErrorKind(e) } };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_LIST_SECRETS,
    async (_event, projectId: string): Promise<IPCResult<DeployListSecretsResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const repo = secretsRepo(project);
      if (!repo) return { success: true, data: { ok: false, kind: 'not-set-up' } };
      try {
        return { success: true, data: { ok: true, names: await listRepoSecretNames(repo.owner, repo.repo) } };
      } catch (e) {
        return { success: true, data: { ok: false, kind: secretErrorKind(e) } };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_PREVIEW_STATE,
    async (_event, projectId: string, taskId: string): Promise<TaskCiState> => {
      const project = projectStore.getProject(projectId);
      const task = project ? projectStore.getTasks(projectId).find((t) => t.id === taskId || t.specId === taskId) : undefined;
      if (!project || !task) return { state: 'not-pushed' };
      return previewState(project, task, {
        actions: createActionsClient(githubFetcher),
        resolveRepo,
      });
    }
  );

  // --- State -----------------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.DEPLOY_STATE, async (_event, projectId: string): Promise<IPCResult<DeployEnvState>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const setup = lastSetup.get(projectId);
    const push = lastPushResult(projectId);
    return {
      success: true,
      data: {
        settings: project.settings.deploy ?? null,
        setupRunning: setupRuns.has(projectId),
        ...(setup ? { lastSetup: setup } : {}),
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
