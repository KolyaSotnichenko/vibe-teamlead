import { describe, expect, it, vi } from 'vitest';

import type { PendingRecipe, PreviewRecipe } from '../../../shared/types/preview';
import type { Project, ProjectSettings } from '../../../shared/types/project';
import { recipeFileText, recipeHash } from '../pending-recipe';
import { createPendingRecipeSettler, type SettleDeps } from '../settle-pending-recipe';

const RECIPE: PreviewRecipe = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] };
const pendingOf = (over: Partial<PendingRecipe> = {}): PendingRecipe => ({ recipe: RECIPE, base: 'none', origin: 'owner', at: '2026-11-23T10:00:00.000Z', ...over });

function setup(pending: PendingRecipe | undefined, over: Partial<SettleDeps> = {}) {
  const project = { id: 'p1', path: '/p1', settings: { previewPendingRecipe: pending } } as unknown as Project;
  const deps: SettleDeps = {
    getProject: (id) => (id === 'p1' ? project : undefined),
    updateSettings: vi.fn((_id: string, settings: Partial<ProjectSettings>) => { Object.assign(project.settings, settings); }),
    mainText: vi.fn(async () => null),
    commit: vi.fn(async () => ({ status: 'merged' as const })),
    ...over,
  };
  return { project, deps, settler: createPendingRecipeSettler(deps) };
}

describe('settling a pending recipe', () => {
  it('has nothing to do without one, and asks nothing of git', async () => {
    const { deps, settler } = setup(undefined);
    expect(await settler.settle('p1')).toBe('none');
    expect(await settler.settle('nope')).toBe('none');
    expect(deps.mainText).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('commits it as the text of its file, and takes it out of the settings', async () => {
    const { project, deps, settler } = setup(pendingOf());
    expect(await settler.settle('p1')).toBe('committed');
    expect(deps.commit).toHaveBeenCalledWith(project, recipeFileText(RECIPE));
    expect(project.settings.previewPendingRecipe).toBeUndefined();
    expect(settler.refusal('p1')).toBeUndefined();
  });

  it("keeps it and remembers git's reason when the commit is refused, until a later one goes through", async () => {
    const commit = vi.fn().mockResolvedValueOnce({ status: 'refused', message: 'The project is on "feature".' }).mockResolvedValue({ status: 'up_to_date' });
    const { project, settler } = setup(pendingOf(), { commit });
    expect(await settler.settle('p1')).toBe('refused');
    expect(project.settings.previewPendingRecipe).toBeDefined();
    expect(settler.refusal('p1')).toBe('The project is on "feature".');
    expect(await settler.settle('p1')).toBe('committed');
    expect(settler.refusal('p1')).toBeUndefined();
    expect(project.settings.previewPendingRecipe).toBeUndefined();
  });

  it('takes it out without a commit when main already means the same recipe', async () => {
    const { project, deps, settler } = setup(pendingOf(), { mainText: vi.fn(async () => recipeFileText(RECIPE)) });
    expect(await settler.settle('p1')).toBe('saved');
    expect(deps.commit).not.toHaveBeenCalled();
    expect(project.settings.previewPendingRecipe).toBeUndefined();
  });

  it("drops it when main has another file than the one it was made against, and says so once for an owner's edit", async () => {
    const other = '{"version":1,"kind":"none"}';
    const owner = setup(pendingOf({ base: recipeHash('older') }), { mainText: vi.fn(async () => other) });
    expect(await owner.settler.settle('p1')).toBe('replaced');
    expect(owner.deps.commit).not.toHaveBeenCalled();
    expect(owner.project.settings.previewPendingRecipe).toBeUndefined();
    expect(owner.settler.takeDropped('p1')).toBe(true);
    expect(owner.settler.takeDropped('p1')).toBe(false);

    const agent = setup(pendingOf({ base: recipeHash('older'), origin: 'agent' }), { mainText: vi.fn(async () => other) });
    expect(await agent.settler.settle('p1')).toBe('replaced');
    expect(agent.settler.takeDropped('p1')).toBe(false);
  });

  it('makes one commit for two calls at once', async () => {
    let release: (value: { status: 'merged' }) => void = () => {};
    const commit = vi.fn(() => new Promise<{ status: 'merged' }>((resolve) => { release = resolve; }));
    const { settler } = setup(pendingOf(), { commit });
    const first = settler.settle('p1');
    const second = settler.settle('p1');
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    release({ status: 'merged' });
    expect(await Promise.all([first, second])).toEqual(['committed', 'committed']);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('leaves a recipe saved while the commit ran', async () => {
    const newer = pendingOf({ at: '2026-11-23T11:00:00.000Z', recipe: { version: 1, kind: 'none' } });
    const { project, settler } = setup(pendingOf(), {
      commit: vi.fn(async () => {
        project.settings.previewPendingRecipe = newer;
        return { status: 'merged' as const };
      }),
    });
    expect(await settler.settle('p1')).toBe('committed');
    expect(project.settings.previewPendingRecipe).toEqual(newer);
  });

  it('says refused, and keeps the recipe, when reading main or committing throws', async () => {
    const { project, settler } = setup(pendingOf(), { commit: vi.fn(async () => { throw new Error('git is gone'); }) });
    expect(await settler.settle('p1')).toBe('refused');
    expect(settler.refusal('p1')).toBe('git is gone');
    expect(project.settings.previewPendingRecipe).toBeDefined();
  });
});
