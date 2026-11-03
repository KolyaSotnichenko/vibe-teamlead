import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolCheck } from '../../../shared/types';

export interface ToolsCheckState {
  tools: ToolCheck[] | null;
  /** A check is running (the first one, or "Check again") */
  checking: boolean;
  error: string | null;
  recheck: () => void;
}

/**
 * Runs the tools check on mount and on `recheck()`. There is no cache in the
 * main process, so every call looks at the Mac again (1–3 s).
 */
export function useToolsCheck(): ToolsCheckState {
  const [tools, setTools] = useState<ToolCheck[] | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  const recheck = useCallback(() => {
    const id = ++run.current;
    setChecking(true);
    setError(null);
    const api = window.electronAPI?.tools;
    const pending = api ? api.check() : Promise.reject(new Error('Tools check is not available'));
    pending
      .then((result) => {
        if (id !== run.current) return;
        if (result.success && result.data) setTools(result.data);
        else setError(result.error ?? 'Unknown error');
      })
      .catch((e: unknown) => {
        if (id === run.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === run.current) setChecking(false);
      });
  }, []);

  useEffect(() => {
    recheck();
    return () => {
      // Ignore results that arrive after unmount
      run.current++;
    };
  }, [recheck]);

  return { tools, checking, error, recheck };
}
