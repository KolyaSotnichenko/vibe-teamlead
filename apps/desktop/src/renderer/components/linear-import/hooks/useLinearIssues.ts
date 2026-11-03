/**
 * Hook for loading Linear issues for a selected team/project
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { LinearIssue } from '../types';

export function useLinearIssues(
  projectId: string,
  selectedTeamId: string,
  selectedProjectId: string,
  onIssuesChange?: () => void
) {
  const { t } = useTranslation('common');
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [isLoadingIssues, setIsLoadingIssues] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref to store the callback to avoid unnecessary re-renders
  const onIssuesChangeRef = useRef(onIssuesChange);
  onIssuesChangeRef.current = onIssuesChange;

  useEffect(() => {
    const loadIssues = async () => {
      if (!selectedTeamId) {
        setIssues([]);
        return;
      }

      setIsLoadingIssues(true);
      setError(null);

      try {
        const result = await window.electronAPI.getLinearIssues(
          projectId,
          selectedTeamId,
          selectedProjectId || undefined
        );
        if (result.success && result.data) {
          setIssues(result.data);
          onIssuesChangeRef.current?.();
        } else {
          setError(result.error || t('linearImport.errors.failedLoadIssues'));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.unknownError'));
      } finally {
        setIsLoadingIssues(false);
      }
    };

    loadIssues();
  }, [projectId, selectedTeamId, selectedProjectId, t]);

  return { issues, isLoadingIssues, error, setError };
}
