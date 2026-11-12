/**
 * The readiness state of a project (the last scan, whether one runs, the tasks by blocker key),
 * read from main and kept live through its updates. The first time a project is read with no
 * result and no scan running, it starts the scan (main ignores 'open' when a result is saved).
 */
import { useEffect, useState } from 'react';
import type { ReadinessState } from '../../../shared/types/deploy';

export function useReadiness(projectId: string): ReadinessState | undefined {
  const [state, setState] = useState<ReadinessState | undefined>();

  useEffect(() => {
    let cancelled = false;
    setState(undefined);
    const deploy = window.electronAPI.deploy;
    Promise.resolve(deploy.readinessState?.(projectId))
      .then((r) => {
        if (cancelled || !r?.success || !r.data) return;
        setState((current) => current ?? r.data);
        if (!r.data.result && !r.data.scanning) void Promise.resolve(deploy.scanReadiness?.(projectId, 'open')).catch(() => undefined);
      })
      .catch(() => undefined);
    const off = deploy.onReadinessUpdate?.((update) => {
      if (update.projectId === projectId) setState(update.state);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [projectId]);

  return state;
}
