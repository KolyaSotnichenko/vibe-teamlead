/**
 * GitHub sign-in with the Vibe Teamlead GitHub App (device flow).
 *
 * The main process requests a device code, opens github.com/login/device and
 * polls until the user approves; this component shows the code and reports
 * the result. Closing it cancels the sign-in in the main process.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, Github, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';

interface GitHubOAuthFlowProps {
  onSuccess: (token: string, username?: string) => void;
  onCancel?: () => void;
}

type Status = 'checking' | 'need-auth' | 'authenticating' | 'success' | 'error';

export function GitHubOAuthFlow({ onSuccess, onCancel }: GitHubOAuthFlowProps) {
  const { t } = useTranslation(['dialogs']);
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<{ code: string; url: string; browserOpened: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const statusRef = useRef<Status>('checking');
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const update = useCallback((next: Status) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const finish = useCallback(
    async (username?: string) => {
      const result = await window.electronAPI.getGitHubToken();
      if (result.success && result.data?.token) {
        update('success');
        onSuccessRef.current(result.data.token, username);
      } else {
        setError(result.error ?? t('dialogs:githubSignIn.failed'));
        update('error');
      }
    },
    [t, update]
  );

  // Already signed in? Then there is nothing to do.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .checkGitHubAuth()
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data?.authenticated) void finish(result.data.username);
        else update('need-auth');
      })
      .catch(() => !cancelled && update('need-auth'));
    return () => {
      cancelled = true;
    };
  }, [finish, update]);

  // Show the device code as soon as the main process has it.
  useEffect(
    () =>
      window.electronAPI.onGitHubAuthDeviceCode((data) =>
        setDevice({ code: data.deviceCode, url: data.authUrl, browserOpened: data.browserOpened })
      ),
    []
  );

  // Leaving mid sign-in cancels the polling in the main process.
  useEffect(
    () => () => {
      if (statusRef.current === 'authenticating') void window.electronAPI.cancelGitHubAuth();
    },
    []
  );

  const start = async () => {
    setError(null);
    setDevice(null);
    setCopied(false);
    update('authenticating');
    try {
      const result = await window.electronAPI.startGitHubAuth();
      if (statusRef.current !== 'authenticating') return; // cancelled meanwhile
      if (result.success) {
        const user = await window.electronAPI.getGitHubUser();
        await finish(user.success ? user.data?.username : undefined);
      } else {
        setError(result.error ?? t('dialogs:githubSignIn.failed'));
        update('error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('dialogs:githubSignIn.failed'));
      update('error');
    }
  };

  const cancel = () => {
    if (statusRef.current === 'authenticating') void window.electronAPI.cancelGitHubAuth();
    update('need-auth');
    onCancel?.();
  };

  const copyCode = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (status === 'checking' || status === 'success') {
    return (
      <div role="status" className="flex items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin motion-reduce:animate-none" />
        {t(status === 'success' ? 'dialogs:githubSignIn.signedIn' : 'dialogs:githubSignIn.checking')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {status === 'need-auth' && (
        <div className="space-y-2 border border-foreground p-5">
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Github aria-hidden="true" className="h-5 w-5" />
            {t('dialogs:githubSignIn.title')}
          </h3>
          <p className="max-w-prose text-sm text-muted-foreground">{t('dialogs:githubSignIn.body')}</p>
        </div>
      )}

      {status === 'authenticating' && (
        <div className="space-y-3 border border-foreground p-5" aria-live="polite">
          {device ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t(device.browserOpened ? 'dialogs:githubSignIn.enterCode' : 'dialogs:githubSignIn.openAndEnterCode')}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <code className="border border-foreground px-3 py-2 font-mono text-2xl font-semibold tracking-[0.2em] text-foreground">
                  {device.code}
                </code>
                <Button variant="outline" onClick={copyCode} className="h-11 gap-2">
                  {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
                  {t(copied ? 'dialogs:githubSignIn.copied' : 'dialogs:githubSignIn.copy')}
                </Button>
                <Button variant="outline" onClick={() => window.open(device.url, '_blank')} className="h-11 gap-2">
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                  {t('dialogs:githubSignIn.openGitHub')}
                </Button>
              </div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <span aria-hidden="true" className="vt-breathe h-2 w-2 bg-foreground" />
                {t('dialogs:githubSignIn.waiting')}
              </p>
            </>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              {t('dialogs:githubSignIn.requesting')}
            </p>
          )}
        </div>
      )}

      {status === 'error' && (
        <div role="alert" className="border border-destructive px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-center gap-3">
        {status !== 'authenticating' && (
          <Button onClick={start} className="h-11 gap-2">
            <Github aria-hidden="true" className="h-4 w-4" />
            {t(status === 'error' ? 'dialogs:githubSignIn.retry' : 'dialogs:githubSignIn.start')}
          </Button>
        )}
        {(onCancel || status === 'authenticating') && (
          <Button variant="ghost" onClick={cancel} className="h-11">
            {t('dialogs:githubSignIn.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
