/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Task } from '../../../../shared/types';
import type { TaskCiState } from '../../../../shared/types/deploy';
import { resetPreviewSubscription, useCiState } from '../useCiState';

const task = { id: 't1', projectId: 'p1' } as unknown as Task;

describe('useCiState', () => {
  let state: TaskCiState;
  let previewState: ReturnType<typeof vi.fn>;
  let push: (u: { projectId: string; taskId: string }) => void;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    state = { state: 'running' };
    previewState = vi.fn(async () => state);
    unsubscribe = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deploy: {
        previewState,
        onPreviewUpdate: vi.fn((cb) => {
          push = cb;
          return unsubscribe;
        }),
      },
    };
  });
  afterEach(() => {
    cleanup();
    resetPreviewSubscription();
    vi.useRealTimers();
  });

  it('asks for the task and returns the state', async () => {
    const { result } = renderHook(() => useCiState(task));
    await act(async () => {});
    expect(previewState).toHaveBeenCalledWith('p1', 't1');
    expect(result.current).toEqual({ state: 'running' });
  });

  it('asks again every 30 s while running, and stops once it passed', async () => {
    renderHook(() => useCiState(task));
    await act(async () => {});
    expect(previewState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(previewState).toHaveBeenCalledTimes(1);
    state = { state: 'passed' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
  });

  it('never polls in settled states', async () => {
    for (const settled of [{ state: 'not-pushed' }, { state: 'passed' }, { state: 'failed', runId: 1 }, { state: 'not-set-up' }] as TaskCiState[]) {
      cleanup();
      resetPreviewSubscription();
      previewState.mockClear();
      state = settled;
      renderHook(() => useCiState(task));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(previewState).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps asking while waiting for the first run of the push', async () => {
    state = { state: 'waiting' };
    renderHook(() => useCiState(task));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(previewState).toHaveBeenCalledTimes(3);
  });

  it('asks again when this task is pushed, not another', async () => {
    state = { state: 'not-pushed' };
    const { result } = renderHook(() => useCiState(task));
    await act(async () => {});
    state = { state: 'running' };
    await act(async () => push({ projectId: 'p1', taskId: 'other' }));
    expect(previewState).toHaveBeenCalledTimes(1);
    await act(async () => push({ projectId: 'p1', taskId: 't1' }));
    expect(previewState).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ state: 'running' });
  });

  it('shares one subscription between cards and lets go on unmount', async () => {
    const a = renderHook(() => useCiState(task));
    const b = renderHook(() => useCiState({ ...task, id: 't2' } as Task));
    expect((window.electronAPI.deploy.onPreviewUpdate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('asks once for two hooks on one running task, and once per 30 s', async () => {
    renderHook(() => useCiState(task));
    renderHook(() => useCiState(task));
    await act(async () => {});
    expect(previewState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
    await act(async () => push({ projectId: 'p1', taskId: 't1' }));
    expect(previewState).toHaveBeenCalledTimes(3);
  });

  it('a later mount reuses a recent answer and stops polling when both leave', async () => {
    const a = renderHook(() => useCiState(task));
    await act(async () => {});
    const b = renderHook(() => useCiState(task));
    expect(b.result.current).toEqual({ state: 'running' });
    await act(async () => {});
    expect(previewState).toHaveBeenCalledTimes(1);
    a.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
    b.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
  });
});
