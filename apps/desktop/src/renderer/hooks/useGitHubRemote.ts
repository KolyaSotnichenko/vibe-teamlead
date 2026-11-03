import { useEffect, useState } from 'react';

/**
 * Whether the project's `origin` remote is a GitHub repository — what creating a PR
 * needs (it pushes the task branch and opens the PR with gh). `null` while checking.
 */
export function useGitHubRemote(projectPath: string | undefined): boolean | null {
  const [hasRemote, setHasRemote] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHasRemote(null);
    if (!projectPath) {
      setHasRemote(false);
      return;
    }
    const detect = window.electronAPI?.detectGitHubRepo;
    if (!detect) {
      setHasRemote(false);
      return;
    }
    detect(projectPath)
      .then((result) => {
        if (!cancelled) setHasRemote(!!result?.success && !!result.data);
      })
      .catch(() => {
        if (!cancelled) setHasRemote(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  return hasRemote;
}
