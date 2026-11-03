import { useCallback, useEffect, useState } from 'react';
import type { ClaudeCredentialStatus } from '../../shared/types';

const NOT_CONFIGURED: ClaudeCredentialStatus = { configured: false, source: 'none' };

/**
 * Status of the app's Claude credential (never the key itself).
 * `refresh` re-reads it, e.g. after the key was saved elsewhere.
 */
export function useClaudeCredential() {
  const [status, setStatus] = useState<ClaudeCredentialStatus>(NOT_CONFIGURED);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.getClaudeCredentialStatus();
      setStatus(result.success && result.data ? result.data : NOT_CONFIGURED);
    } catch {
      setStatus(NOT_CONFIGURED);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, setStatus, isLoading, refresh };
}
