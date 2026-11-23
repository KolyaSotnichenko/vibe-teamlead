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
  /** A check before the start (fix-start.ts), not a failed start */
  check?: { changed: string[]; first?: boolean };
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
  /** The owner stops it: the session and the start end, the failed start is shown again, and it does not start by itself for that failure again */
  cancel: () => Promise<void>;
  /**
   * The preview is being stopped or replaced from outside (the owner left it, or started a preview):
   * the session ends without a word, a try that is starting is waited for and stopped. Await it
   * before starting another preview.
   */
  previewStopped: () => Promise<void>;
  running: () => boolean;
  /**
   * Before a start of the project's preview: the agent checks the project and tries its recipe,
   * by the same rules and the same bound per day as a run after a failed start. The status the
   * last try ended in, with what was found; null when it did not run (one is running, no key,
   * the owner turned the agent off, the day's bound is reached), and the start goes on as before.
   */
  check: (project: Project, info: FailedStart, check: { changed: string[]; first?: boolean }) => Promise<PreviewStatus | null>;
}

interface Running {
  projectId: string;
  controller: AbortController;
  tries: number;
  /** The failure the owner saw: what the run is about, and what asking again is about */
  failed: PreviewStatus;
  info: FailedStart;
  auto: boolean;
  /** The latest status of the project's preview while the run lasts, the tries' own included */
  latest: PreviewStatus;
  /** The start of a try that is under way */
  trying: Promise<unknown> | null;
  /** A check before the start */
  check?: { changed: string[]; first?: boolean };
}

/** What the agent can do something about: a failed start of the project's own preview, of a recipe the preview can show */
const fixable = (status: PreviewStatus) => !status.taskId && status.stage === 'failed' && !!status.failedAt && status.recipe?.kind === 'web';

const appSaid = (summary: string): { summary: string; summarySaid?: SaidText } => {
  const said = saidFor([summary])[0];
  return said ? { summary, summarySaid: said } : { summary };
};

/** What the page shows for what the agent found */
function shownFor(outcome: FixOutcome): PreviewFix {
  if (outcome.outcome === 'fixed') return { state: 'done', outcome: 'fixed', ...appSaid(outcome.summary) };
  if (outcome.outcome === 'needs_code_change') return { state: 'done', outcome: 'needs_code_change', summary: outcome.summary, task: outcome.task };
  if (outcome.outcome === 'needs_owner') return { state: 'done', outcome: 'needs_owner', summary: outcome.summary, missing: outcome.missing };
  if (outcome.sessionFailed) return { state: 'done', outcome: 'unknown', ...appSaid(say('fixFailed', `The agent's session failed: ${outcome.summary}`, { reason: outcome.summary })) };
  return { state: 'done', outcome: 'unknown', ...appSaid(outcome.summary) };
}

export function createStartFixer(deps: StartFixerDeps): StartFixer {
  const now = deps.now ?? (() => new Date());
  let run: Running | null = null;
  /** What the page is shown for each project's preview, next to its status */
  const shown = new Map<string, PreviewFix>();
  /** The failed start of each project the agent may be asked about */
  const lastFailed = new Map<string, PreviewStatus>();

  const attach = (status: PreviewStatus): PreviewStatus => {
    if (status.taskId) return status;
    if (run?.projectId === status.projectId) return { ...status, fix: { state: 'running', tries: run.tries, ...(run.check ? { check: true as const } : {}) } };
    const fix = shown.get(status.projectId);
    return fix ? { ...status, fix } : status;
  };

  /** Ends a run from outside: the session is aborted, a try that is starting is waited for, then its preview is stopped */
  const end = async (mine: Running): Promise<void> => {
    if (run === mine) run = null;
    mine.controller.abort();
    if (mine.trying) await mine.trying.catch(() => undefined);
    await deps.stop(mine.projectId).catch(() => undefined);
  };

  const start = async (project: Project, failed: PreviewStatus, info: FailedStart, auto: boolean, check?: { changed: string[]; first?: boolean }): Promise<PreviewStatus> => {
    const id = project.id;
    if (!deps.hasCredential()) {
      // Nothing ran, so nothing is kept: with a key, the same failure is looked at
      shown.set(id, { state: 'done', outcome: 'unknown', ...appSaid(say('fixNoCredential', 'No Claude key is set (Settings → Claude), so the agent could not look at why the project does not start.')) });
      deps.send(attach(failed));
      return attach(failed);
    }
    const ledger = deps.ledger(id);
    // Counted now: a run the owner leaves half-way costs as much as one that finishes
    if (auto) ledger.begin(now());
    const mine: Running = { projectId: id, controller: new AbortController(), tries: 0, failed, info, auto, latest: failed, trying: null, ...(check ? { check } : {}) };
    run = mine;
    shown.delete(id);
    if (!check) lastFailed.set(id, failed);
    deps.send(attach(failed));
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
          deps.send(attach(mine.latest));
        },
        ...(check ? { check } : {}),
        // The app's own start, with the candidate as the project's recipe that is not in main yet
        tryRecipe: async (recipe) => {
          if (mine.controller.signal.aborted) throw new Error('The agent was stopped.');
          const trying = deps.tryStart({ ...project, settings: { ...project.settings, previewPendingRecipe: pendingOf(recipe) } });
          mine.trying = trying;
          try {
            mine.latest = await trying;
          } finally {
            if (mine.trying === trying) mine.trying = null;
          }
          return mine.latest;
        },
      });
      if (mine.controller.signal.aborted || run !== mine) return mine.latest;
      run = null;
      // Up when the agent said so, but stopped since: the recipe did not hold
      const held = outcome.outcome !== 'fixed' || mine.latest.stage === 'ready';
      const kept: FixOutcome = held ? outcome : { outcome: 'unknown', summary: say('fixDidNotHold', "The project came up by the agent's recipe, then stopped again, so the recipe was not kept.") };
      ledger.record(info.key, kept, auto, now());
      shown.set(id, shownFor(kept));
      if (kept.outcome === 'fixed') {
        lastFailed.delete(id);
        deps.updateSettings(id, { previewPendingRecipe: pendingOf(kept.recipe) });
        deps.settle(id);
        deps.send(attach(mine.latest));
        return attach(mine.latest);
      }
      return ended(mine);
    } catch (error) {
      if (mine.controller.signal.aborted || run !== mine) return mine.latest;
      run = null;
      const reason = error instanceof Error ? error.message : String(error);
      const kept: FixOutcome = { outcome: 'unknown', summary: reason, sessionFailed: true };
      ledger.record(info.key, kept, auto, now());
      shown.set(id, shownFor(kept));
      return ended(mine);
    }
  };

  /** A run that did not make it start: what was found goes on the failed status the owner sees, and they may ask again */
  const ended = (mine: Running): PreviewStatus => {
    const shownOn = mine.latest.stage === 'failed' || mine.check ? mine.latest : mine.failed;
    // After a failed start, asking again is about the failure the owner saw; after a check, the last try's is the only one
    if (mine.check && shownOn.stage === 'failed') lastFailed.set(mine.projectId, shownOn);
    deps.send(attach(shownOn));
    return attach(shownOn);
  };

  const consider = async (status: PreviewStatus): Promise<void> => {
    const id = status.projectId;
    const project = deps.getProject(id);
    if (!project) return;
    const info = await deps.describe(project, status).catch(() => null);
    // A newer status, a stop, or a run has taken over meanwhile
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
      // The run's own tries: what they end in is what the run goes by
      if (run?.projectId === id) {
        run.latest = status;
        return attach(status);
      }
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
      // The failure the owner saw, not the last try of a run before
      const info = await deps.describe(project, failed).catch(() => null);
      if (!info || run || lastFailed.get(projectId) !== failed) return false;
      void start(project, failed, info, false);
      return true;
    },
    cancel: async () => {
      const mine = run;
      if (!mine) return;
      await end(mine);
      // The owner's choice for this failure: it does not start again by itself, and asking again stays open
      const stopped: FixOutcome = { outcome: 'unknown', summary: say('fixStoppedByOwner', 'You stopped the agent. It does not start again by itself for this failure; ask it again when you want.') };
      deps.ledger(mine.projectId).record(mine.info.key, stopped, mine.auto, now());
      shown.set(mine.projectId, shownFor(stopped));
      lastFailed.set(mine.projectId, mine.failed);
      deps.send(attach(mine.failed));
    },
    previewStopped: async () => {
      // A failure looked up while the owner leaves starts nothing afterwards
      lastFailed.clear();
      shown.clear();
      const mine = run;
      if (mine) await end(mine);
    },
    running: () => run !== null,
    check: async (project, info, check) => {
      if (run || !deps.hasCredential() || project.settings.previewFixAutomatically === false) return null;
      if (!deps.ledger(project.id).mayRunAutomatically(info.key, now())) return null;
      // What the page shows while the agent checks: the start has not begun
      const starting: PreviewStatus = { projectId: project.id, stage: 'worktree', origins: [] };
      return start(project, starting, info, true, check);
    },
  };
}
