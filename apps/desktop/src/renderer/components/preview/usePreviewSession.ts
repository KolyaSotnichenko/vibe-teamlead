/**
 * The Preview runs only while its page is on screen: mounting starts it, and
 * unmounting, or another project, stops it. The box the page reserves is where
 * the main process places the preview's view. The view is drawn above the
 * app's own page, so it steps aside while any of the app's dialogs, or a panel
 * that floats over the page, is open.
 */

/** The app's dialogs, and its panels that float over the page (`data-over-preview`: an agent's question) */
const DIALOG = '[role="dialog"], [role="alertdialog"], [data-over-preview]';

import { useEffect, useRef, useState } from 'react';

import type { PreviewStatus } from '../../../shared/types';
import { clippingRects, visibleBounds } from './visible-bounds';

/** `taskId`: a task's preview (its worktree), shown inside the task's window */
export function usePreviewSession(projectId: string | null, enabled: boolean, taskId?: string) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId || !enabled) return;
    const api = window.electronAPI.preview;
    let live = true;
    setStatus(null);
    const unsubscribe = api.onStatus((next) => {
      if (live && next.projectId === projectId && next.taskId === taskId) setStatus(next);
    });

    // Sent only when it changed, at most once a frame: the dialog watch sees every DOM change
    let last: string | undefined;
    let frame = 0;
    /** The box whose size is watched: the page mounts a new one after the services form */
    let watched: Element | null = null;
    const measure = () => {
      frame = 0;
      const box = boxRef.current;
      if (box !== watched) {
        if (watched) observer?.unobserve(watched);
        if (box) observer?.observe(box);
        watched = box;
      }
      // No box on the page (the services form is shown instead): the view steps aside, the preview goes on
      const rect = box?.isConnected ? box.getBoundingClientRect() : null;
      // A dialog the page sits in (the task's window) doesn't count; any other would be covered
      const covered = !box || Array.from(document.querySelectorAll(DIALOG)).some((dialog) => !dialog.contains(box));
      // Only the part that is on screen: the view is drawn above the page, and nothing in it clips the view
      const bounds = box && rect && !covered && rect.width > 0 && rect.height > 0
        ? visibleBounds(rect, clippingRects(box), { width: window.innerWidth, height: window.innerHeight })
        : null;
      const key = JSON.stringify(bounds);
      if (key === last) return;
      last = key;
      void api.setBounds(bounds);
    };
    const report = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    window.addEventListener('resize', report);
    // A scroll anywhere (the task's window) moves the box without resizing it
    window.addEventListener('scroll', report, true);
    const dialogs = typeof MutationObserver === 'undefined' ? null : new MutationObserver(report);
    dialogs?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'data-over-preview'] });

    void (taskId ? api.start(projectId, taskId) : api.start(projectId)).then((result) => {
      // A start refused before any status (a task without a worktree) still says why
      if (live && result && !result.success) setStatus({ projectId, ...(taskId ? { taskId } : {}), stage: 'failed', origins: [], message: result.error });
      report();
    });

    return () => {
      live = false;
      unsubscribe();
      observer?.disconnect();
      dialogs?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      void api.setBounds(null);
      void api.stop();
    };
  }, [projectId, enabled, taskId]);

  return { status, boxRef };
}
