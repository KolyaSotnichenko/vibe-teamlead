/**
 * What happens to a recipe made in the app (pending-recipe.ts) at each start of a project's
 * preview and after each merge into its main: once main means the same recipe it is saved,
 * and forgotten here; once main has another file than the one it was made against, a task
 * changed the recipe since, main wins and it is dropped (an owner's own edit is said once);
 * otherwise the app commits it (recipe-commit.ts, through the project's merge queue). A
 * refusal keeps it, with git's reason, for the next try: the preview runs by it meanwhile.
 * One at a time per project. No Electron imports: everything it touches is passed in.
 */

import type { Project, ProjectSettings } from '../../shared/types/project';
import { pendingState, recipeFileText } from './pending-recipe';

export interface SettleDeps {
  getProject: (id: string) => Project | undefined;
  updateSettings: (id: string, settings: Partial<ProjectSettings>) => void;
  /** main's preview.json, null when it has none */
  mainText: (project: Project) => Promise<string | null>;
  /** Through the project's merge queue */
  commit: (project: Project, text: string) => Promise<{ status: 'merged' | 'up_to_date' | 'refused'; message?: string }>;
}

export type Settled = 'none' | 'saved' | 'replaced' | 'committed' | 'refused';

export interface PendingRecipeSettler {
  settle: (projectId: string) => Promise<Settled>;
  /** Why the last attempt for this project was refused, while its recipe is still pending */
  refusal: (projectId: string) => string | undefined;
  /** True once after an owner's pending edit was dropped because main's recipe changed */
  takeDropped: (projectId: string) => boolean;
}

export function createPendingRecipeSettler(deps: SettleDeps): PendingRecipeSettler {
  const running = new Map<string, Promise<Settled>>();
  const refusals = new Map<string, string>();
  const dropped = new Set<string>();

  /** Out of the settings, unless another one was saved meanwhile: that one waits its turn */
  const forget = (projectId: string, settled: { at: string; base: string }) => {
    const now = deps.getProject(projectId)?.settings.previewPendingRecipe;
    if (now && now.at === settled.at && now.base === settled.base) deps.updateSettings(projectId, { previewPendingRecipe: undefined });
  };

  const settleNow = async (projectId: string): Promise<Settled> => {
    const project = deps.getProject(projectId);
    const pending = project?.settings.previewPendingRecipe;
    if (!project || !pending) {
      refusals.delete(projectId);
      return 'none';
    }
    try {
      const state = pendingState(pending, await deps.mainText(project));
      if (state === 'saved' || state === 'replaced') {
        forget(projectId, pending);
        refusals.delete(projectId);
        if (state === 'replaced' && pending.origin === 'owner') dropped.add(projectId);
        return state;
      }
      const result = await deps.commit(project, recipeFileText(pending.recipe));
      if (result.status === 'refused') {
        refusals.set(projectId, result.message ?? 'The project could not take the change.');
        return 'refused';
      }
      forget(projectId, pending);
      refusals.delete(projectId);
      return 'committed';
    } catch (error) {
      refusals.set(projectId, error instanceof Error ? error.message : String(error));
      return 'refused';
    }
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
