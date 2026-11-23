/**
 * When the agent that fixes a preview start (fix-start.ts) runs, and what becomes of what it
 * finds. Every status of a preview passes through here on its way to the page. A failed start
 * of the project's preview is looked up in the ledger (fix-ledger.ts): a failure already
 * worked on shows what was found; a new one starts the agent by itself, within the ledger's
 * bounds and the project's setting; otherwise the page gets a button. Each recipe the agent
 * proposes is started by the app as the project's recipe that is not in main yet; one that
 * came up becomes exactly that (and goes on to main, settle-pending-recipe.ts). The owner can
 * stop it; leaving the preview stops it too, and a stopped run keeps nothing.
 * No Electron imports: everything it touches is passed in.
 */

import type { SaidText } from '../../shared/constants/preview-say';
import type { PreviewFix, PreviewRecipe, PreviewRecipeSource, PreviewStatus } from '../../shared/types/preview';
import type { Project, ProjectSettings } from '../../shared/types/project';
import { saidFor, say } from '../say';
import type { FixLedger } from './fix-ledger';
import type { FixFailure, FixOutcome } from './fix-start';

/** One session of the agent, as the fixer asks for it: the caller adds the model, the facts and the session runner */
export interface FixRun {
  projectId: string;
  failure: FixFailure;
  recipe: PreviewRecipe;
  source: PreviewRecipeSource;
  tryRecipe: (recipe: PreviewRecipe) => Promise<PreviewStatus>;
  signal: AbortSignal;
  onTry: (n: number) => void;
}

/** A failed start as the ledger knows it, with the recipe it used */
export interface FailedStart {
  key: string;
  recipe: PreviewRecipe;
  source: PreviewRecipeSource;
  /** The hash of main's preview.json: what a recipe made now is made against */
  base: string;
}

export interface StartFixerDeps {
  getProject: (id: string) => Project | undefined;
  updateSettings: (id: string, settings: Partial<ProjectSettings>) => void;
  /** The failed start as the ledger knows it; null when it can't be described */
  describe: (project: Project, failed: PreviewStatus) => Promise<FailedStart | null>;
  ledger: (projectId: string) => FixLedger;
  hasCredential: () => boolean;
  fix: (run: FixRun) => Promise<FixOutcome>;
  /** The app's own start of the project's preview, by this project's settings */
  tryStart: (project: Project) => Promise<PreviewStatus>;
  stop: (projectId: string) => Promise<void>;
  /** A recipe was kept: it goes on to main */
  settle: (projectId: string) => void;
  /** To the page */
  send: (status: PreviewStatus) => void;
  now?: () => Date;
}

export interface StartFixer {
  /** A status on its way to the page: it comes back with the fix's state, and a failed start may start the agent */
  onStatus: (status: PreviewStatus) => PreviewStatus;
  /** The owner asks for the agent on the project's last failed start. False when there is none, or one is running. */
  ask: (projectId: string) => Promise<boolean>;
  /** The owner stops it: the session and the start end, the failed start is shown again */
  cancel: () => Promise<void>;
  /** The preview was stopped from outside (the owner left it): the session ends without a word */
  previewStopped: () => void;
  running: () => boolean;
}

interface Running {
  projectId: string;
  controller: AbortController;
  tries: number;
  failed: PreviewStatus;
  /** Stopped by the owner: `cancel` says what is shown next */
  cancelling: boolean;
}

/** What the agent can do something about: a failed start of the project's own preview, of a recipe the preview can show */
const fixable = (status: PreviewStatus) => !status.taskId && status.stage === 'failed' && !!status.failedAt && status.recipe?.kind === 'web';

const appSaid = (summary: string): { summary: string; summarySaid?: SaidText } => {
  const said = saidFor([summary])[0];
  return said ? { summary, summarySaid: said } : { summary };
};

/** What the page shows for what the agent found */
function shownFor(outcome: FixOutcome): PreviewFix {
  if (outcome.outcome === 'fixed') return { state: 'done', outcome: 'fixed', summary: outcome.summary };
  if (outcome.outcome === 'needs_code_change') return { state: 'done', outcome: 'needs_code_change', summary: outcome.summary, task: outcome.task };
  if (outcome.outcome === 'needs_owner') return { state: 'done', outcome: 'needs_owner', summary: outcome.summary, missing: outcome.missing };
  if (outcome.sessionFailed) return { state: 'done', outcome: 'unknown', ...appSaid(say('fixFailed', `The agent's session failed: ${outcome.summary}`, { reason: outcome.summary })) };
  return { state: 'done', outcome: 'unknown', summary: outcome.summary };
}

export function createStartFixer(deps: StartFixerDeps): StartFixer {
  const now = deps.now ?? (() => new Date());
  let run: Running | null = null;
  /** What the page is shown for each project's preview, next to its status */
  const shown = new Map<string, PreviewFix>();
  const lastFailed = new Map<string, PreviewStatus>();

  const attach = (status: PreviewStatus): PreviewStatus => {
    if (status.taskId) return status;
    if (run?.projectId === status.projectId) return { ...status, fix: { state: 'running', tries: run.tries } };
    const fix = shown.get(status.projectId);
    return fix ? { ...status, fix } : status;
  };

  const start = async (project: Project, failed: PreviewStatus, info: FailedStart, auto: boolean): Promise<void> => {
    const id = project.id;
    if (!deps.hasCredential()) {
      // Nothing ran, so nothing is kept: with a key, the same failure is looked at
      shown.set(id, { state: 'done', outcome: 'unknown', ...appSaid(say('fixNoCredential', 'No Claude key is set (Settings → Claude), so the agent could not look at why the project does not start.')) });
      deps.send(attach(failed));
      return;
    }
    const mine: Running = { projectId: id, controller: new AbortController(), tries: 0, failed, cancelling: false };
    run = mine;
    shown.delete(id);
    deps.send(attach(failed));
    /** The status the last start ended in: a failed try replaces the failure the owner saw */
    let last = failed;
    const pendingOf = (recipe: PreviewRecipe) => ({ recipe, base: info.base, origin: 'agent' as const, at: now().toISOString() });
    try {
      const outcome = await deps.fix({
        projectId: id,
        failure: { stage: failed.failedAt, service: failed.failedService, message: failed.message, logTail: failed.logTail },
        recipe: info.recipe,
        source: info.source,
        signal: mine.controller.signal,
        onTry: (n) => {
          mine.tries = n;
          deps.send(attach(last));
        },
        // The app's own start, with the candidate as the project's recipe that is not in main yet
        tryRecipe: async (recipe) => {
          last = await deps.tryStart({ ...project, settings: { ...project.settings, previewPendingRecipe: pendingOf(recipe) } });
          return last;
        },
      });
      if (mine.controller.signal.aborted) return;
      run = null;
      deps.ledger(id).record(info.key, outcome, auto, now());
      shown.set(id, shownFor(outcome));
      if (outcome.outcome === 'fixed') {
        deps.updateSettings(id, { previewPendingRecipe: pendingOf(outcome.recipe) });
        deps.settle(id);
        deps.send(attach(last));
        return;
      }
      const end = last.stage === 'failed' ? last : failed;
      lastFailed.set(id, end);
      deps.send(attach(end));
    } catch (error) {
      if (mine.controller.signal.aborted) return;
      run = null;
      const reason = error instanceof Error ? error.message : String(error);
      shown.set(id, shownFor({ outcome: 'unknown', summary: reason, sessionFailed: true }));
      deps.send(attach(last.stage === 'failed' ? last : failed));
    } finally {
      // A stopped run: `cancel` shows the failed start again; a preview stopped from outside shows nothing
      if (run === mine && !mine.cancelling) run = null;
    }
  };

  const consider = async (status: PreviewStatus): Promise<void> => {
    const id = status.projectId;
    const project = deps.getProject(id);
    if (!project) return;
    const info = await deps.describe(project, status).catch(() => null);
    // A newer status, or a run, has taken over meanwhile
    if (!info || lastFailed.get(id) !== status || run) return;
    const ledger = deps.ledger(id);
    const kept = ledger.get(info.key);
    // "Fixed" kept for a failure that is back did not hold: the owner may ask again
    if (kept && kept.outcome.outcome !== 'fixed') {
      shown.set(id, shownFor(kept.outcome));
      deps.send(attach(status));
      return;
    }
    if (!kept && project.settings.previewFixAutomatically !== false && ledger.mayRunAutomatically(info.key, now())) {
      await start(project, status, info, true);
      return;
    }
    shown.set(id, { state: 'idle' });
    deps.send(attach(status));
  };

  return {
    onStatus: (status) => {
      if (status.taskId) return status;
      const id = status.projectId;
      // The run's own tries
      if (run?.projectId === id) return attach(status);
      if (status.stage === 'failed') {
        shown.delete(id);
        if (fixable(status)) {
          lastFailed.set(id, status);
          void consider(status);
        } else {
          lastFailed.delete(id);
        }
        return status;
      }
      if (status.stage === 'ready') {
        // What the agent changed is said while the preview it fixed is up
        const fix = shown.get(id);
        if (!(fix?.state === 'done' && fix.outcome === 'fixed')) shown.delete(id);
        lastFailed.delete(id);
        return attach(status);
      }
      // A new start, or a stop: what was found belongs to the start before
      shown.delete(id);
      if (status.stage === 'stopped') lastFailed.delete(id);
      return status;
    },
    ask: async (projectId) => {
      const failed = lastFailed.get(projectId);
      const project = deps.getProject(projectId);
      if (!failed || !project || run) return false;
      const info = await deps.describe(project, failed).catch(() => null);
      if (!info || run || lastFailed.get(projectId) !== failed) return false;
      void start(project, failed, info, false);
      return true;
    },
    cancel: async () => {
      const mine = run;
      if (!mine) return;
      mine.cancelling = true;
      mine.controller.abort();
      await deps.stop(mine.projectId).catch(() => {});
      if (run === mine) run = null;
      shown.set(mine.projectId, { state: 'idle' });
      lastFailed.set(mine.projectId, mine.failed);
      deps.send(attach(mine.failed));
    },
    previewStopped: () => {
      const mine = run;
      if (!mine) return;
      run = null;
      mine.controller.abort();
      shown.delete(mine.projectId);
      lastFailed.delete(mine.projectId);
    },
    running: () => run !== null,
  };
}
