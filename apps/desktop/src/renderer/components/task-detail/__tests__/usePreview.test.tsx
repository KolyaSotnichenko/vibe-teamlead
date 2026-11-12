/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Task } from '../../../../shared/types';
import type { TaskPreview } from '../../../../shared/types/deploy';
import { resetPreviewSubscription, usePreview } from '../usePreview';

const task = { id: 't1', projectId: 'p1' } as unknown as Task;

describe('usePreview', () => {
  let state: TaskPreview;
  let previewState: ReturnType<typeof vi.fn>;
  let push: (u: { projectId: string; taskId: string }) => void;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    state = { state: 'building' };
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
    const { result } = renderHook(() => usePreview(task));
    await act(async () => {});
    expect(previewState).toHaveBeenCalledWith('p1', 't1');
    expect(result.current).toEqual({ state: 'building' });
  });

  it('asks again every 30 s while building, and stops once it is ready', async () => {
    renderHook(() => usePreview(task));
    await act(async () => {});
    expect(previewState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(previewState).toHaveBeenCalledTimes(1);
    state = { state: 'ready', url: 'https://x.vercel.app', builtAt: '2026-01-01T00:00:00Z' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(previewState).toHaveBeenCalledTimes(2);
  });

  it('never polls in other states', async () => {
    state = { state: 'not-pushed' };
    renderHook(() => usePreview(task));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(previewState).toHaveBeenCalledTimes(1);
  });

  it('asks again when this task is pushed, not another', async () => {
    state = { state: 'not-pushed' };
    const { result } = renderHook(() => usePreview(task));
    await act(async () => {});
    state = { state: 'building' };
    await act(async () => push({ projectId: 'p1', taskId: 'other' }));
    expect(previewState).toHaveBeenCalledTimes(1);
    await act(async () => push({ projectId: 'p1', taskId: 't1' }));
    expect(previewState).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ state: 'building' });
  });

  it('shares one subscription between cards and lets go on unmount', async () => {
    const a = renderHook(() => usePreview(task));
    const b = renderHook(() => usePreview({ ...task, id: 't2' } as Task));
    expect((window.electronAPI.deploy.onPreviewUpdate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('asks once for two hooks on one building task, and once per 30 s', async () => {
    renderHook(() => usePreview(task));
    renderHook(() => usePreview(task));
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
    const a = renderHook(() => usePreview(task));
    await act(async () => {});
    const b = renderHook(() => usePreview(task));
    expect(b.result.current).toEqual({ state: 'building' });
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
