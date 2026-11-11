/**
 * Giving the Vibe Teamlead GitHub App access to repositories.
 *
 * Signing in (GitHubOAuthFlow) only authorizes the app; it reaches private
 * repositories once it is installed on the account and given the repository.
 * - GitHubAppInstallStep: shown after sign-in until the app is installed.
 * - GitHubRepoAccessNotice: shown when GitHub answers 404 for a repository.
 * Both check again when the window regains focus (the user comes back from GitHub).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { GITHUB_APP_INSTALL_URL, GITHUB_INSTALLATIONS_SETTINGS_URL } from '../../../shared/constants/github';
import type { GitHubAppAccess } from '../../../shared/types';

function openUrl(url: string): void {
  void Promise.resolve(window.electronAPI.openExternal(url)).catch(() => undefined);
}

/** Calls `callback` whenever the app window regains focus. */
function useOnWindowFocus(callback: () => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const onFocus = () => ref.current();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}

type InstallStatus = 'checking' | 'needs-install' | 'error';

interface GitHubAppInstallStepProps {
  /** Called once the app is installed. */
  onInstalled: () => void;
  onCancel?: () => void;
}

export function GitHubAppInstallStep({ onInstalled, onCancel }: GitHubAppInstallStepProps) {
  const { t } = useTranslation(['dialogs']);
  const [status, setStatus] = useState<InstallStatus>('checking');
  const [busy, setBusy] = useState(false);
  /** A check the user asked for found the app still missing. */
  const [stillMissing, setStillMissing] = useState(false);
  const done = useRef(false);
  const inFlight = useRef(false);
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  const check = useCallback(async (manual: boolean) => {
    if (done.current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await window.electronAPI.getGitHubAppAccess();
      if (done.current) return;
      if (result.success && result.data?.installed) {
        done.current = true;
        onInstalledRef.current();
      } else if (result.success && result.data) {
        setStatus('needs-install');
        if (manual) setStillMissing(true);
      } else {
        setStatus('error');
      }
    } catch {
      if (!done.current) setStatus('error');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check(false);
  }, [check]);

  useOnWindowFocus(() => {
    if (status !== 'checking') void check(false);
  });

  if (status === 'checking') {
    return (
      <div role="status" className="flex items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin motion-reduce:animate-none" />
        {t('dialogs:githubAppAccess.checking')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {status === 'needs-install' ? (
        <div className="space-y-2 border border-foreground p-5">
          <h3 className="text-base font-semibold text-foreground">{t('dialogs:githubAppAccess.title')}</h3>
          <p className="max-w-prose text-sm text-muted-foreground">{t('dialogs:githubAppAccess.body')}</p>
          {stillMissing && (
            <p role="status" className="text-sm text-foreground">
              {t('dialogs:githubAppAccess.stillMissing')}
            </p>
          )}
        </div>
      ) : (
        <div role="alert" className="border border-destructive px-4 py-3 text-sm text-destructive">
          {t('dialogs:githubAppAccess.error')}
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-3">
        {status === 'needs-install' && (
          <Button onClick={() => openUrl(GITHUB_APP_INSTALL_URL)} className="h-11 gap-2">
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            {t('dialogs:githubAppAccess.install')}
          </Button>
        )}
        <Button variant="outline" onClick={() => void check(true)} disabled={busy} className="h-11 gap-2">
          {busy ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
          )}
          {t('dialogs:githubAppAccess.checkAgain')}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} className="h-11">
            {t('dialogs:githubSignIn.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface GitHubRepoAccessNoticeProps {
  /** owner/repo */
  repo: string;
  /** The app's installation for the repository; null when it could not be checked. */
  access: GitHubAppAccess | null;
  onCheckAgain: () => void;
  checking?: boolean;
}

/** GitHub answered 404 for a repository: explain the app's access instead of the HTTP error. */
export function GitHubRepoAccessNotice({ repo, access, onCheckAgain, checking }: GitHubRepoAccessNoticeProps) {
  const { t } = useTranslation(['dialogs']);
  const owner = repo.split('/')[0];
  const checkingRef = useRef(checking);
  checkingRef.current = checking;
  useOnWindowFocus(() => {
    if (!checkingRef.current) onCheckAgain();
  });

  let body: string;
  let action: { label: string; url: string };
  if (access && !access.installed) {
    body = t('dialogs:githubAppAccess.repoNotInstalled', { owner });
    action = { label: t('dialogs:githubAppAccess.installApp'), url: GITHUB_APP_INSTALL_URL };
  } else if (access?.repositorySelection === 'selected') {
    body = t('dialogs:githubAppAccess.repoSelected');
    action = { label: t('dialogs:githubAppAccess.addRepo'), url: GITHUB_INSTALLATIONS_SETTINGS_URL };
  } else {
    body = t('dialogs:githubAppAccess.repoUnknown');
    action = { label: t('dialogs:githubAppAccess.manageAccess'), url: GITHUB_INSTALLATIONS_SETTINGS_URL };
  }

  return (
    <div role="alert" className="space-y-3 border-l-2 border-destructive bg-muted px-4 py-3 text-sm">
      <p className="font-semibold text-foreground">{t('dialogs:githubAppAccess.repoTitle', { repo })}</p>
      <p className="text-muted-foreground">{body}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => openUrl(action.url)} className="gap-2">
          <ExternalLink aria-hidden="true" className="h-4 w-4" />
          {action.label}
        </Button>
        <Button size="sm" variant="outline" onClick={onCheckAgain} disabled={checking} className="gap-2">
          {checking ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
          )}
          {t('dialogs:githubAppAccess.checkAgainShort')}
        </Button>
      </div>
    </div>
  );
}
