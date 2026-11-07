/**
 * The Preview runs only while its page is on screen: mounting starts it, and
 * unmounting, or another project, stops it. The box the page reserves is where
 * the main process places the preview's view.
 */

import { useEffect, useRef, useState } from 'react';

import type { PreviewStatus } from '../../../shared/types';

export function usePreviewSession(projectId: string | null, enabled: boolean) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId || !enabled) return;
    const api = window.electronAPI.preview;
    let live = true;
    setStatus(null);
    const unsubscribe = api.onStatus((next) => {
      if (live && next.projectId === projectId) setStatus(next);
    });

    const report = () => {
      const box = boxRef.current;
      if (!box) return;
      const rect = box.getBoundingClientRect();
      void api.setBounds(rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    if (boxRef.current) observer?.observe(boxRef.current);
    window.addEventListener('resize', report);

    void api.start(projectId).then(report);

    return () => {
      live = false;
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener('resize', report);
      void api.setBounds(null);
      void api.stop();
    };
  }, [projectId, enabled]);

  return { status, boxRef };
}
