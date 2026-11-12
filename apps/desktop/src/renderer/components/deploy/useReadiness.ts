/**
 * The readiness state of a project (the last scan, whether one runs, the tasks by blocker key),
 * read from main and kept live through its updates.
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
        if (!cancelled && r?.success && r.data) setState((current) => current ?? r.data);
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
