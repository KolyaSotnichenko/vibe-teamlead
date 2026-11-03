import { useClaudeCredential } from '../../../hooks/useClaudeCredential';

/**
 * Hook to check if the ideation feature can run: the app's Claude credential
 * (API key, or subscription token in personal mode) is configured.
 *
 * @returns { hasToken, isLoading }
 * - hasToken: true if a Claude credential is configured
 * - isLoading: true while the status loads
 */
export function useIdeationAuth() {
  const { status, isLoading } = useClaudeCredential();
  return { hasToken: status.configured, isLoading };
}
