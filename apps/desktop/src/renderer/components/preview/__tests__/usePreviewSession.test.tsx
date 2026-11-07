/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreviewStatus } from '../../../../shared/types';
import { usePreviewSession } from '../usePreviewSession';

let listener: ((status: PreviewStatus) => void) | null = null;
const preview = {
  start: vi.fn(async () => ({ success: true })),
  stop: vi.fn(async () => ({ success: true })),
  onStatus: vi.fn((cb: (status: PreviewStatus) => void) => {
    listener = cb;
    return () => { listener = null; };
  }),
  setBounds: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { ...(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, preview };
});

describe('usePreviewSession', () => {
  it('starts on mount and stops on unmount', () => {
    const { unmount } = renderHook(() => usePreviewSession('p1', true));
    expect(preview.start).toHaveBeenCalledWith('p1');
    unmount();
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(preview.setBounds).toHaveBeenLastCalledWith(null);
  });

  it('does not start while the project has no services', () => {
    renderHook(() => usePreviewSession('p1', false));
    expect(preview.start).not.toHaveBeenCalled();
  });

  it('switching the project stops the old preview, then starts the new one', () => {
    const { rerender } = renderHook(({ id }) => usePreviewSession(id, true), { initialProps: { id: 'p1' } });
    rerender({ id: 'p2' });
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(preview.start).toHaveBeenLastCalledWith('p2');
    expect(preview.stop.mock.invocationCallOrder[0]).toBeLessThan(preview.start.mock.invocationCallOrder[1]);
  });

  it("keeps only its own project's status, and none after unmount", () => {
    const { result, unmount } = renderHook(() => usePreviewSession('p1', true));
    act(() => listener?.({ projectId: 'p2', stage: 'ready', origins: [] }));
    expect(result.current.status).toBeNull();
    act(() => listener?.({ projectId: 'p1', stage: 'database', origins: [] }));
    expect(result.current.status?.stage).toBe('database');
    unmount();
    expect(listener).toBeNull();
  });

  it("hides the view while one of the app's dialogs is open, since the view would cover it", async () => {
    const { result } = renderHook(() => usePreviewSession('p1', true));
    const box = document.createElement('div');
    box.getBoundingClientRect = () => ({ left: 10, top: 50, width: 800, height: 600 }) as DOMRect;
    document.body.appendChild(box);
    (result.current.boxRef as { current: HTMLDivElement | null }).current = box;

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    await vi.waitFor(() => expect(preview.setBounds).toHaveBeenLastCalledWith(null));

    dialog.remove();
    await vi.waitFor(() => expect(preview.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 50, width: 800, height: 600 }));
    box.remove();
  });
});

