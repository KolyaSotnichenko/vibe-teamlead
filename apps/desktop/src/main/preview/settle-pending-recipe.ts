/**
 * What happens to a recipe made in the app (pending-recipe.ts) at each start of a project's
 * preview and after each merge into its main: once main means the same recipe it is saved,
 * and forgotten here; once main has another file than the one it was made against, a task
 * changed the recipe since, main wins and it is dropped (an owner's own edit is said once);
 * otherwise the app commits it (recipe-commit.ts, through the project's merge queue, which
 * checks once more, at the moment of writing, that main still has the file it was made
 * against). A refusal keeps it, with the reason, for the next try: the preview runs by it
 * meanwhile. An edit saved while an earlier one was being committed is committed after it, on
 * top of it. One at a time per project. No Electron imports: everything it touches is passed in.
 */

import type { PendingRecipe } from '../../shared/types/preview';
import type { Project, ProjectSettings } from '../../shared/types/project';
import { say } from '../say';
import { pendingState, recipeFileText, recipeHash } from './pending-recipe';
import { parseRecipe, recipeDirs } from './recipe';

export interface SettleDeps {
  getProject: (id: string) => Project | undefined;
  updateSettings: (id: string, settings: Partial<ProjectSettings>) => void;
  /** main's preview.json, null when it has none */
  mainText: (project: Project) => Promise<string | null>;
  /**
   * Through the project's merge queue. `base`: the hash of the file the recipe was made against;
   * `replaced` when main has another by the time the commit's turn comes.
   */
  commit: (project: Project, text: string, base: string) => Promise<{ status: 'merged' | 'up_to_date' | 'refused' | 'replaced'; message?: string }>;
  /** Whether a folder of the project, followed through any links, is inside it. Without it folders are checked as text only. */
  contained?: (project: Project, dir: string) => boolean;
}

export type Settled = 'none' | 'saved' | 'replaced' | 'committed' | 'refused';

export interface PendingRecipeSettler {
  settle: (projectId: string) => Promise<Settled>;
  /** Why the last attempt for this project was refused, while its recipe is still pending */
  refusal: (projectId: string) => string | undefined;
  /** True once after an owner's pending edit was dropped because main's recipe changed */
  takeDropped: (projectId: string) => boolean;
}

/** An owner can save again and again while a commit waits: each is settled in turn, up to this many in one go */
const MAX_IN_ONE_GO = 5;

const same = (a: PendingRecipe, b: PendingRecipe) => a.at === b.at && a.base === b.base;

export function createPendingRecipeSettler(deps: SettleDeps): PendingRecipeSettler {
  const running = new Map<string, Promise<Settled>>();
  const refusals = new Map<string, string>();
  const dropped = new Set<string>();

  /**
   * The settled recipe goes out of the settings. Another one saved meanwhile stays, and waits its
   * turn: when it was made against the same file and main now has `mainNow` (the settled one,
   * just written), it is moved onto that, so the owner's own earlier edit doesn't count against it.
   */
  const forget = (projectId: string, settled: PendingRecipe, mainNow?: string) => {
    const now = deps.getProject(projectId)?.settings.previewPendingRecipe;
    if (!now) return;
    if (same(now, settled)) deps.updateSettings(projectId, { previewPendingRecipe: undefined });
    else if (mainNow !== undefined && now.base === settled.base) deps.updateSettings(projectId, { previewPendingRecipe: { ...now, base: recipeHash(mainNow) } });
  };

  const drop = (projectId: string, pending: PendingRecipe): Settled => {
    forget(projectId, pending);
    refusals.delete(projectId);
    if (pending.origin === 'owner') dropped.add(projectId);
    return 'replaced';
  };

  const settleOne = async (project: Project, pending: PendingRecipe): Promise<Settled> => {
    // The settings file is not trusted more than the repository: what could not be used is not written either
    const checked = parseRecipe(recipeFileText(pending.recipe));
    if (!checked.ok || recipeDirs(checked.recipe).some((dir) => dir !== '' && deps.contained?.(project, dir) === false)) {
      forget(project.id, pending);
      refusals.delete(project.id);
      return 'none';
    }
    const mainText = await deps.mainText(project);
    const state = pendingState(pending, mainText);
    if (state === 'replaced') return drop(project.id, pending);
    if (state === 'saved') {
      forget(project.id, pending, mainText ?? undefined);
      refusals.delete(project.id);
      return 'saved';
    }
    const text = recipeFileText(pending.recipe);
    const result = await deps.commit(project, text, pending.base);
    if (result.status === 'replaced') return drop(project.id, pending);
    if (result.status === 'refused') {
      refusals.set(project.id, result.message || say('recipeNotTaken', 'The project could not take the change.'));
      return 'refused';
    }
    forget(project.id, pending, text);
    refusals.delete(project.id);
    return 'committed';
  };

  const settleNow = async (projectId: string): Promise<Settled> => {
    let last: Settled = 'none';
    for (let turn = 0; turn < MAX_IN_ONE_GO; turn++) {
      const project = deps.getProject(projectId);
      const pending = project?.settings.previewPendingRecipe;
      if (!project || !pending) {
        if (turn === 0) refusals.delete(projectId);
        return last;
      }
      try {
        last = await settleOne(project, pending);
      } catch (error) {
        refusals.set(projectId, error instanceof Error ? error.message : String(error));
        return 'refused';
      }
      // A refusal waits for the next try; anything else may have left a newer edit to settle
      if (last === 'refused') return last;
    }
    return last;
  };

  return {
    settle: (projectId) => {
      const already = running.get(projectId);
      if (already) return already;
      const run = settleNow(projectId).finally(() => running.delete(projectId));
      running.set(projectId, run);
      return run;
    },
    refusal: (projectId) => (deps.getProject(projectId)?.settings.previewPendingRecipe ? refusals.get(projectId) : undefined),
    takeDropped: (projectId) => dropped.delete(projectId),
  };
}
