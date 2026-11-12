/**
 * Settings → Vercel: sign in in the browser (the app runs the Vercel CLI's
 * device flow), or paste a token. Tokens are write-only from here; main keeps
 * them and only reports the account.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import type { VercelConnectState, VercelStatus } from '../../../shared/types';

/** Error codes from main (credential kinds and status kinds); anything else shows the generic text. */
const ERROR_KINDS: ReadonlySet<string> = new Set([
  'timeout',
  'busy',
  'download',
  'cli',
  'empty',
  'encryption-unavailable',
  'unknown',
  'unreachable',
  'unavailable',
]);

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'connecting'; state: VercelConnectState };

interface VercelPanelProps {
  /** Called with the account's connectedness after each status change. */
  onStatusChange?: (connected: boolean) => void;
}

export function VercelPanel({ onStatusChange }: VercelPanelProps = {}) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<VercelStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'token' | 'disconnect' | null>(null);
  const connectRunning = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const errorText = useCallback(
    (kind: string | undefined): string => t(`vercel.errors.${kind && ERROR_KINDS.has(kind) ? kind : 'unknown'}`),
    [t],
  );

  const load = useCallback(async () => {
    const result = await window.electronAPI.vercel.status();
    if (result.success && result.data) {
      setStatus(result.data);
      if (result.data.error) setError(errorText(result.data.error));
    } else {
      setStatus({ connected: false });
      setError(t('vercel.errors.statusFailed'));
    }
  }, [t, errorText]);

  useEffect(() => {
    void load();
    return window.electronAPI.vercel.onConnectState((state) => setPhase({ kind: 'connecting', state }));
  }, [load]);

  useEffect(() => {
    if (status) onStatusChangeRef.current?.(status.connected);
  }, [status]);

  // A sign-in this panel started must not outlive it (the wizard step can be left mid-flow).
  useEffect(
    () => () => {
      if (connectRunning.current) void window.electronAPI.vercel.cancelConnect();
    },
    [],
  );

  const handleConnect = async () => {
    setError(null);
    connectRunning.current = true;
    setPhase({ kind: 'starting' });
    try {
      const result = await window.electronAPI.vercel.connect();
      if (result.success && result.data) {
        setStatus(result.data);
      } else if (result.error !== 'cancelled') {
        setError(errorText(result.error));
      }
    } finally {
      connectRunning.current = false;
      setPhase({ kind: 'idle' });
    }
  };

  const handleCancel = () => {
    void window.electronAPI.vercel.cancelConnect();
  };

  const handleDisconnect = async () => {
    setBusy('disconnect');
    setError(null);
    try {
      const result = await window.electronAPI.vercel.disconnect();
      if (result.success && result.data) setStatus(result.data);
      else setError(t('vercel.errors.disconnectFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveToken = async () => {
    setBusy('token');
    setError(null);
    try {
      const result = await window.electronAPI.vercel.setToken(token);
      if (result.success && result.data?.connected) {
        setStatus(result.data);
        setToken('');
        setShowPaste(false);
      } else if (result.success) {
        setError(result.data?.error ? errorText(result.data.error) : t('vercel.errors.tokenRejected'));
      } else {
        setError(errorText(result.error));
      }
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('vercel.loading')}
      </div>
    );
  }

  const errorLine = error && (
    <p role="alert" className="border-l-2 border-destructive bg-muted px-3 py-2 text-sm text-foreground">
      {error}
    </p>
  );

  if (phase.kind !== 'idle') {
    const state = phase.kind === 'connecting' ? phase.state : null;
    return (
      <div className="space-y-4">
        {state?.phase === 'waiting' ? (
          <div className="space-y-2 border-l-2 border-foreground bg-muted px-3 py-2">
            <p className="text-sm text-muted-foreground">{t('vercel.waiting.code')}</p>
            <p className="font-mono text-lg text-foreground">{state.code ?? state.url}</p>
            <p className="flex items-center gap-2 text-sm text-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('vercel.waiting.label')}
            </p>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {state?.phase === 'downloading'
              ? t('vercel.downloading', { percent: state.percent })
              : t('vercel.starting')}
          </p>
        )}
        <Button variant="outline" onClick={handleCancel}>
          {t('vercel.cancel')}
        </Button>
      </div>
    );
  }

  if (status.connected) {
    return (
      <div className="space-y-4">
        <div role="status" className="space-y-1 border-l-2 border-foreground bg-muted px-3 py-2 text-sm">
          <p className="text-muted-foreground">
            {status.source === 'token' ? t('vercel.connected.viaToken') : t('vercel.connected.viaBrowser')}
          </p>
          <p className="font-mono text-foreground">{status.user?.username}</p>
          {status.user?.email && <p className="text-muted-foreground">{status.user.email}</p>}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t('vercel.connected.teams')}</p>
          {status.teams && status.teams.length > 0 ? (
            <ul className="space-y-1 text-sm text-foreground">
              {status.teams.map((team) => (
                <li key={team.id} className="flex gap-2">
                  <span>{team.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{team.slug}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('vercel.connected.noTeams')}</p>
          )}
        </div>
        {errorLine}
        <Button variant="outline" onClick={handleDisconnect} disabled={busy !== null}>
          {busy === 'disconnect' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('vercel.disconnect')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('vercel.notConnected')}</p>
      {errorLine}
      <Button onClick={handleConnect}>{t('vercel.connect')}</Button>
      <div className="space-y-2">
        <Button variant="link" className="h-auto p-0" aria-expanded={showPaste} onClick={() => setShowPaste((v) => !v)}>
          {t('vercel.paste.toggle')}
        </Button>
        {showPaste && (
          <div className="space-y-2">
            <Label htmlFor="vercelToken" className="text-sm font-medium text-foreground">
              {t('vercel.paste.label')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('vercel.paste.hint')}</p>
            <div className="flex gap-2">
              <Input
                id="vercelToken"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button onClick={handleSaveToken} disabled={busy !== null || token.trim().length === 0}>
                {busy === 'token' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('vercel.paste.save')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
