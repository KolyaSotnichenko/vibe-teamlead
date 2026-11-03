/**
 * The app's Claude credential: one Anthropic API key (or, in personal mode, a
 * Claude subscription token). The key is write-only from here — the main
 * process stores it encrypted and only reports a status with the last four
 * characters.
 *
 * Used by Settings → Claude, the onboarding wizard and the GitHub setup dialog.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { cn } from '../../lib/utils';
import type { ClaudeConnectionTestResult, ClaudeCredentialStatus } from '../../../shared/types';

interface ClaudeCredentialPanelProps {
  status: ClaudeCredentialStatus;
  onStatusChange: (status: ClaudeCredentialStatus) => void;
  /** Base URL to test with (the unsaved value from the form, if any) */
  baseUrl?: string;
}

function StatusLine({ status }: { status: ClaudeCredentialStatus }) {
  const { t } = useTranslation('settings');
  const needsKey = !status.configured;
  let text: string;
  if (needsKey) {
    text = t('claude.status.none');
  } else {
    const what = status.kind === 'subscription-token' ? t('claude.status.token') : t('claude.status.apiKey');
    const where = status.source === 'environment' ? t('claude.status.fromEnvironment') : t('claude.status.stored');
    text = `${what} · ${where}`;
  }
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-between gap-4 border-l-2 bg-muted px-3 py-2 text-sm',
        needsKey ? 'border-warning text-foreground' : 'border-foreground text-muted-foreground'
      )}
    >
      <span>{text}</span>
      {status.hint && <span className="font-mono text-xs text-foreground">••••{status.hint}</span>}
    </div>
  );
}

export function ClaudeCredentialPanel({ status, onStatusChange, baseUrl }: ClaudeCredentialPanelProps) {
  const { t } = useTranslation('settings');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<'save' | 'clear' | 'test' | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ClaudeConnectionTestResult | null>(null);

  const handleSave = async () => {
    setBusy('save');
    setFieldError(null);
    setTestResult(null);
    try {
      const result = await window.electronAPI.saveClaudeApiKey(apiKey);
      if (result.success && result.data) {
        onStatusChange(result.data);
        setApiKey('');
        setShowKey(false);
      } else {
        setFieldError(result.error ?? t('claude.errors.saveFailed'));
      }
    } catch {
      setFieldError(t('claude.errors.saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    setFieldError(null);
    setTestResult(null);
    try {
      const result = await window.electronAPI.clearClaudeApiKey();
      if (result.success && result.data) onStatusChange(result.data);
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const result = await window.electronAPI.testClaudeConnection({
        apiKey: apiKey.trim() || undefined,
        baseUrl,
      });
      setTestResult(result.success && result.data ? result.data : { ok: false, error: result.error });
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const canTest = status.configured || apiKey.trim().length > 0;

  return (
    <div className="space-y-4">
      <StatusLine status={status} />

      <div className="space-y-2">
        <Label htmlFor="claudeApiKey" className="text-sm font-medium text-foreground">
          {status.source === 'stored' ? t('claude.apiKey.replaceLabel') : t('claude.apiKey.label')}
        </Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="claudeApiKey"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('claude.apiKey.placeholder')}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setFieldError(null);
              }}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby="claudeApiKeyHelp"
              className={cn('pr-11 font-mono', fieldError && 'border-destructive')}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? t('claude.apiKey.hide') : t('claude.apiKey.show')}
              className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button onClick={handleSave} disabled={!apiKey.trim() || busy !== null}>
            {busy === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('claude.apiKey.save')}
          </Button>
        </div>
        {fieldError ? (
          <p className="text-sm text-destructive">{fieldError}</p>
        ) : (
          <p id="claudeApiKeyHelp" className="text-sm text-muted-foreground">
            {t('claude.apiKey.help')}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={handleTest} disabled={!canTest || busy !== null}>
          {busy === 'test' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {busy === 'test' ? t('claude.test.running') : t('claude.test.button')}
        </Button>
        {status.source === 'stored' && (
          <Button variant="ghost" onClick={handleClear} disabled={busy !== null}>
            {t('claude.apiKey.remove')}
          </Button>
        )}
      </div>

      {testResult && (
        <div
          role="status"
          className={cn(
            'border-l-2 bg-muted px-3 py-2 text-sm',
            testResult.ok ? 'border-foreground text-foreground' : 'border-warning text-foreground'
          )}
        >
          <p className="font-medium">{testResult.ok ? t('claude.test.ok') : t('claude.test.failed')}</p>
          {!testResult.ok && testResult.error && (
            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{testResult.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
