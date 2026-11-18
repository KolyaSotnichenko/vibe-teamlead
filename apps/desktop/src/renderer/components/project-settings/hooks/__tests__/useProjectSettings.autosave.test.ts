/**
 * @vitest-environment jsdom
 */
/**
 * Project settings save by themselves when their section is left or Settings closes, so
 * handleSave writes only what changed and reports a failure to the caller.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateProjectSettings } = vi.hoisted(() => ({ updateProjectSettings: vi.fn(async () => true) }));
vi.mock('../../../../stores/project-store', () => ({
  updateProjectSettings,
  checkProjectVersion: vi.fn(async () => null),
  initializeProject: vi.fn(),
}));
vi.mock('../../../../stores/github', () => ({ checkGitHubConnection: vi.fn() }));
vi.mock('../../../../stores/project-env-store', () => ({ setProjectEnvConfig: vi.fn() }));
const { queueSettingsSaved } = vi.hoisted(() => ({ queueSettingsSaved: vi.fn(async () => undefined) }));
vi.mock('../../../../lib/queue-settings', async (importActual) => ({
  ...(await importActual<typeof import('../../../../lib/queue-settings')>()),
  queueSettingsSaved,
}));
vi.mock('../../../../../shared/i18n', () => ({ default: { t: (key: string) => key } }));

import { useProjectSettings } from '../useProjectSettings';
import type { Project } from '../../../../../shared/types';

const env = { claudeAuthStatus: 'none' } as never;
const updateProjectEnv = vi.fn(async (_id: string, _env: unknown): Promise<{ success: boolean; error?: string }> => ({ success: true }));
const project = { id: 'p1', autoBuildPath: '.auto', settings: { model: 'a' } } as unknown as Project;

beforeEach(() => {
  updateProjectSettings.mockClear();
  queueSettingsSaved.mockClear();
  updateProjectEnv.mockReset();
  updateProjectEnv.mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getProjectEnv: vi.fn(async () => ({ success: true, data: env })),
    updateProjectEnv,
  };
});

async function mounted() {
  const hook = renderHook(() => useProjectSettings(project, true));
  await waitFor(() => expect(hook.result.current.envConfig).toBeTruthy());
  return hook;
}

describe('useProjectSettings handleSave', () => {
  it('writes nothing when nothing changed', async () => {
    const { result } = await mounted();
    expect(result.current.hasUnsavedChanges()).toBe(false);
    let res: { ok: boolean; error: string | null } | undefined;
    await act(async () => { res = await result.current.handleSave(); });
    expect(res).toEqual({ ok: true, error: null });
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(updateProjectEnv).not.toHaveBeenCalled();
  });

  it('writes the changed project settings', async () => {
    const { result } = await mounted();
    act(() => result.current.setSettings({ model: 'b' } as never));
    expect(result.current.hasUnsavedChanges()).toBe(true);
    await act(async () => { await result.current.handleSave(); });
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { model: 'b' });
    expect(updateProjectEnv).not.toHaveBeenCalled();
  });

  it('reports a failed save', async () => {
    updateProjectSettings.mockResolvedValueOnce(false);
    const { result } = await mounted();
    act(() => result.current.setSettings({ model: 'b' } as never));
    let res: { ok: boolean; error: string | null } | undefined;
    await act(async () => { res = await result.current.handleSave(); });
    expect(res?.ok).toBe(false);
    expect(res?.error).toBeTruthy();
  });

  it('retries an environment change whose immediate save failed', async () => {
    const { result } = await mounted();
    updateProjectEnv.mockResolvedValueOnce({ success: false, error: 'disk full' });
    await act(async () => { await result.current.updateEnvConfig({ linearEnabled: true } as never); });
    expect(result.current.envError).toBe('disk full');
    expect(result.current.hasUnsavedChanges()).toBe(true);
    let res: { ok: boolean; error: string | null } | undefined;
    await act(async () => { res = await result.current.handleSave(); });
    expect(res).toEqual({ ok: true, error: null });
    expect(updateProjectEnv).toHaveBeenLastCalledWith('p1', expect.objectContaining({ linearEnabled: true }));
    expect(result.current.envError).toBeNull();
  });

  it('refuses a parallel task limit out of range and writes nothing', async () => {
    const { result } = await mounted();
    act(() => result.current.setSettings({ model: 'a', maxParallelTasks: 4 } as never));
    let res: { ok: boolean; error: string | null } | undefined;
    await act(async () => { res = await result.current.handleSave(); });
    expect(res).toEqual({ ok: false, error: 'tasks:queue.settings.maxValueError' });
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(queueSettingsSaved).not.toHaveBeenCalled();
  });

  it('applies the queue settings once they are saved (the offer to merge the tasks that wait)', async () => {
    const { result } = await mounted();
    act(() => result.current.setSettings({ model: 'a', maxParallelTasks: 2, autoMerge: true } as never));
    await act(async () => { await result.current.handleSave(); });
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { model: 'a', maxParallelTasks: 2, autoMerge: true });
    expect(queueSettingsSaved).toHaveBeenCalledWith('p1', { model: 'a' }, { model: 'a', maxParallelTasks: 2, autoMerge: true });
  });

  it('does not apply them when the save failed', async () => {
    updateProjectSettings.mockResolvedValueOnce(false);
    const { result } = await mounted();
    act(() => result.current.setSettings({ model: 'a', autoMerge: true } as never));
    await act(async () => { await result.current.handleSave(); });
    expect(queueSettingsSaved).not.toHaveBeenCalled();
  });
});
