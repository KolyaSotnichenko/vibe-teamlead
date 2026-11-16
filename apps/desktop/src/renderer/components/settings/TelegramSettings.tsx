/**
 * Settings → Telegram: the user's own bot. The token is write-only from here (the main process
 * keeps it encrypted and reports only a status); pairing shows a one-time `/start` code; the
 * switches choose which notifications go to the chat, and when the morning digest comes. Off until
 * a token is saved.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import type { TelegramDigestSettings, TelegramErrorReason, TelegramNotificationKind, TelegramStatus } from '../../../shared/types/telegram';

const NOTIFICATION_KINDS: TelegramNotificationKind[] = ['agentQuestion', 'reviewWaiting', 'taskFailed', 'ciFailed', 'taskMerged', 'regression'];

type FieldError = TelegramErrorReason | 'empty_token';

export function TelegramSettings() {
  const { t, i18n } = useTranslation('telegram');
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | 'code' | null>(null);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [testedName, setTestedName] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.telegram;
    if (!api) return;
    let alive = true;
    void api.getStatus().then((s) => alive && setStatus(s));
    const off = api.onStatus((s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const api = () => window.electronAPI.telegram;

  const save = async () => {
    setBusy('save');
    setFieldError(null);
    setTestedName(null);
    try {
      const result = await api().saveToken(token);
      if (result.success && result.data) {
        setStatus(result.data);
        setToken('');
        setShowToken(false);
      } else {
        setFieldError(result.error ?? 'unknown');
      }
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setFieldError(null);
    setTestedName(null);
    try {
      const result = await api().testToken(token);
      if (result.success) setTestedName(result.data?.username ?? '');
      else setFieldError(result.error ?? 'unknown');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      setStatus(await api().removeToken());
    } finally {
      setBusy(null);
    }
  };

  const newCode = async () => {
    setBusy('code');
    try {
      setStatus(await api().newPairingCode());
    } finally {
      setBusy(null);
    }
  };

  const unpair = async () => setStatus(await api().unpair());

  const toggle = async (kind: TelegramNotificationKind, on: boolean) => {
    if (!status) return;
    const next = { ...status.notifications, [kind]: on };
    setStatus({ ...status, notifications: next });
    setStatus(await api().setNotifications(next));
  };

  const changeDigest = async (patch: Partial<TelegramDigestSettings>) => {
    if (!status) return;
    const next = { ...status.digest, ...patch };
    setStatus({ ...status, digest: next });
    setStatus(await api().setDigest(next));
  };

  const hasToken = !!status && status.connection !== 'not_set';
  const statusText = (() => {
    if (!status) return '';
    switch (status.connection) {
      case 'not_set':
        return t('settings.status.not_set');
      case 'connected':
        return status.botUsername ? t('settings.status.connected', { username: status.botUsername }) : t('settings.status.connectedNoName');
      case 'connecting':
        return t('settings.status.connecting');
      default:
        return t('settings.status.error', { reason: t(`settings.errors.${status.error ?? 'unknown'}`) });
    }
  })();
  const statusWarns = status?.connection === 'error' || status?.connection === 'not_set';
  const startCommand = status?.pairingCode ? `/start ${status.pairingCode}` : '';
  const expires = status?.pairingExpiresAt
    ? new Date(status.pairingExpiresAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <SettingsSection title={t('settings.title')} description={t('settings.description')}>
      <div className="space-y-8">
        <p className="text-sm text-muted-foreground">{t('settings.intro')}</p>

        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground">{t('settings.steps.title')}</h4>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
            <li>{t('settings.steps.createBot')}</li>
            <li>{t('settings.steps.pasteToken')}</li>
            <li>{t('settings.steps.sendStart')}</li>
          </ol>
        </div>

        {/* Status */}
        <div
          role="status"
          className={cn(
            'flex items-center justify-between gap-4 border-l-2 bg-muted px-3 py-2 text-sm',
            statusWarns ? 'border-warning text-foreground' : 'border-foreground text-muted-foreground'
          )}
        >
          <span>{statusText}</span>
        </div>

        {/* Token */}
        <div className="space-y-2">
          <Label htmlFor="telegramToken" className="text-sm font-medium text-foreground">
            {t('settings.token.label')}
          </Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="telegramToken"
                type={showToken ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('settings.token.placeholder')}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setFieldError(null);
                  setTestedName(null);
                }}
                aria-invalid={fieldError ? true : undefined}
                className={cn('pr-11 font-mono', fieldError && 'border-destructive')}
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? t('settings.token.hide') : t('settings.token.show')}
                className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={save} disabled={!token.trim() || busy !== null}>
              {busy === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.token.save')}
            </Button>
            <Button variant="outline" onClick={test} disabled={!token.trim() || busy !== null}>
              {busy === 'test' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.token.test')}
            </Button>
          </div>
          {fieldError ? (
            <p className="text-sm text-destructive">{t(`settings.errors.${fieldError}`)}</p>
          ) : testedName !== null ? (
            <p className="text-sm text-foreground">{t('settings.token.testOk', { username: testedName })}</p>
          ) : hasToken ? (
            <p className="text-sm text-muted-foreground">{t('settings.token.saved')}</p>
          ) : null}
          {hasToken && (
            <Button variant="ghost" onClick={remove} disabled={busy !== null}>
              {t('settings.token.remove')}
            </Button>
          )}
        </div>

        {/* Pairing */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">{t('settings.pairing.title')}</h4>
          {status?.owner ? (
            <div className="flex items-center justify-between gap-4 border border-border px-4 py-3">
              <span className="text-sm text-foreground">
                {status.owner.name
                  ? t('settings.pairing.paired', { name: status.owner.name })
                  : t('settings.pairing.pairedNoName', { id: status.owner.userId })}
              </span>
              <Button variant="outline" onClick={unpair}>
                {t('settings.pairing.unpair')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.pairing.notPaired')}</p>
          )}
          {!hasToken ? (
            <p className="text-sm text-muted-foreground">{t('settings.pairing.needToken')}</p>
          ) : (
            <div className="space-y-2">
              {startCommand && (
                <div className="space-y-2 border border-foreground px-4 py-3">
                  <p className="text-sm text-muted-foreground">{t('settings.pairing.instructions')}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="font-mono text-base text-foreground">{startCommand}</code>
                    <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(startCommand)}>
                      {t('settings.pairing.copy')}
                    </Button>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">{t('settings.pairing.expires', { time: expires })}</p>
                  {status?.botUsername && (
                    <a
                      href={`https://t.me/${status.botUsername}?start=${status.pairingCode}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-foreground underline underline-offset-2"
                    >
                      {t('settings.pairing.openLink')}
                    </a>
                  )}
                </div>
              )}
              <Button variant="outline" onClick={newCode} disabled={busy !== null}>
                {busy === 'code' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('settings.pairing.newCode')}
              </Button>
            </div>
          )}
        </div>

        {/* Notifications */}
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">{t('settings.notifications.title')}</h4>
            <p className="text-sm text-muted-foreground">{t('settings.notifications.description')}</p>
          </div>
          <div className="divide-y divide-border border border-border">
            {NOTIFICATION_KINDS.map((kind) => (
              <div key={kind} className="flex items-center justify-between gap-4 px-4 py-3">
                <Label htmlFor={`telegram-${kind}`} className="text-sm text-foreground">
                  {t(`settings.notifications.${kind}`)}
                </Label>
                <Switch
                  id={`telegram-${kind}`}
                  checked={status?.notifications[kind] ?? true}
                  disabled={!status}
                  onCheckedChange={(on) => void toggle(kind, on)}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Morning digest */}
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">{t('settings.digest.title')}</h4>
            <p className="text-sm text-muted-foreground">{t('settings.digest.description')}</p>
          </div>
          <div className="divide-y divide-border border border-border">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <Label htmlFor="telegram-digest" className="text-sm text-foreground">
                {t('settings.digest.enabled')}
              </Label>
              <Switch
                id="telegram-digest"
                checked={status?.digest.enabled ?? true}
                disabled={!status}
                onCheckedChange={(on) => void changeDigest({ enabled: on })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <Label htmlFor="telegram-digest-time" className="text-sm text-foreground">
                {t('settings.digest.time')}
              </Label>
              <Input
                id="telegram-digest-time"
                type="time"
                className="w-32 font-mono"
                value={status?.digest.time ?? '09:00'}
                disabled={!status}
                onChange={(event) => {
                  if (/^\d{2}:\d{2}$/.test(event.target.value)) void changeDigest({ time: event.target.value });
                }}
              />
            </div>
          </div>
        </div>

        {/* Privacy */}
        <div className="space-y-1 border-l-2 border-foreground bg-muted px-3 py-2">
          <h4 className="text-sm font-medium text-foreground">{t('settings.privacy.title')}</h4>
          <p className="text-sm text-muted-foreground">{t('settings.privacy.body')}</p>
        </div>
      </div>
    </SettingsSection>
  );
}
