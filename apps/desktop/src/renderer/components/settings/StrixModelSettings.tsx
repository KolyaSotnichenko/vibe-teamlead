/**
 * Settings → Security QA → Model for Strix: the provider, the model and only that
 * provider's credentials. Provider, model and non-secret fields are settings;
 * secrets are write-only from here (the main process keeps them encrypted and
 * reports only which are saved).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  STRIX_PROVIDER_IDS,
  STRIX_PROVIDERS,
  strixProviderFields,
  strixProviderSecrets,
  type StrixFieldName,
  type StrixProviderId,
  type StrixSecretName,
  type StrixSecretStatus,
} from '../../../shared/constants/strix-providers';
import type { AppSettings } from '../../../shared/types';

/** Examples shown in empty fields: identifiers and URLs, not language */
const FIELD_PLACEHOLDERS: Partial<Record<StrixFieldName, string>> = {
  apiBase: 'http://localhost:11434',
  azureApiBase: 'https://<resource>.openai.azure.com',
  azureApiVersion: '2025-11-01-preview',
  awsAccessKeyId: 'AKIA…',
  awsProfile: 'default',
  awsRegion: 'us-east-1',
  vertexProject: 'my-gcp-project',
  vertexLocation: 'global',
};

/** The settings after choosing a provider: its example model is prefilled. */
export function withStrixProvider(settings: AppSettings, provider: StrixProviderId): AppSettings {
  return { ...settings, securityQaProvider: provider, securityQaModel: STRIX_PROVIDERS[provider].exampleModel };
}

interface Props {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export function StrixModelSettings({ settings, onSettingsChange }: Props) {
  const { t } = useTranslation('settings');
  const provider: StrixProviderId = settings.securityQaProvider ?? 'agents';
  const info = STRIX_PROVIDERS[provider];
  const fields = settings.securityQaProviderFields ?? {};
  const [status, setStatus] = useState<StrixSecretStatus>({});

  useEffect(() => {
    const api = window.electronAPI?.strix;
    if (!api) return;
    let alive = true;
    void api.getSecretsStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);

  const setField = (name: StrixFieldName | 'awsAuth', value: string) =>
    onSettingsChange({ ...settings, securityQaProviderFields: { ...fields, [name]: value } });

  const pickFile = async () => {
    const path = await window.electronAPI?.strix?.pickCredentialsFile();
    if (path) setField('vertexCredentialsFile', path);
  };

  return (
    <div className="max-w-md space-y-3 border-l-2 border-border pl-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground">{t('general.securityQaLlm.title')}</h4>
        <p className="text-xs text-muted-foreground">{t('general.securityQaLlm.description')}</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="securityQaProvider" className="text-xs text-muted-foreground">
          {t('general.securityQaLlm.provider')}
        </Label>
        <Select value={provider} onValueChange={(value) => onSettingsChange(withStrixProvider(settings, value as StrixProviderId))}>
          <SelectTrigger id="securityQaProvider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STRIX_PROVIDER_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {t(`general.securityQaLlm.providers.${id}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {provider !== 'agents' && (
        <div className="space-y-1">
          <Label htmlFor="securityQaModel" className="text-xs text-muted-foreground">
            {t('general.securityQaLlm.model')}
          </Label>
          <Input
            id="securityQaModel"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            placeholder={info.modelPlaceholder}
            value={settings.securityQaModel ?? ''}
            onChange={(e) => onSettingsChange({ ...settings, securityQaModel: e.target.value })}
          />
        </div>
      )}

      {provider === 'bedrock' && (
        <div className="space-y-1">
          <Label htmlFor="securityQaAwsAuth" className="text-xs text-muted-foreground">
            {t('general.securityQaLlm.awsAuth')}
          </Label>
          <Select value={fields.awsAuth ?? 'keys'} onValueChange={(value) => setField('awsAuth', value)}>
            <SelectTrigger id="securityQaAwsAuth">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keys">{t('general.securityQaLlm.awsAuthKeys')}</SelectItem>
              <SelectItem value="profile">{t('general.securityQaLlm.awsAuthProfile')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {strixProviderFields(provider, fields).map((name) => (
        <div key={name} className="space-y-1">
          <Label htmlFor={`strix-${name}`} className="text-xs text-muted-foreground">
            {t(`general.securityQaLlm.fields.${name}`)}
          </Label>
          <div className="flex gap-2">
            <Input
              id={`strix-${name}`}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              placeholder={FIELD_PLACEHOLDERS[name] ?? ''}
              value={fields[name] ?? ''}
              onChange={(e) => setField(name, e.target.value)}
            />
            {name === 'vertexCredentialsFile' && (
              <Button type="button" variant="outline" onClick={() => void pickFile()}>
                {t('general.securityQaLlm.chooseFile')}
              </Button>
            )}
          </div>
          {name === 'vertexCredentialsFile' && <p className="text-xs text-muted-foreground">{t('general.securityQaLlm.vertexAdcHint')}</p>}
        </div>
      ))}

      {strixProviderSecrets(provider, fields).map((name) => (
        <SecretField key={`${provider}-${name}`} provider={provider} name={name} saved={status[provider]?.[name] === true} onStatus={setStatus} />
      ))}

      {info.notes.map((note) => (
        <p key={note} className="border-l-2 border-foreground bg-muted px-3 py-2 text-xs text-foreground">
          {t(`general.securityQaLlm.notes.${note}`)}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">{t('general.securityQaLlm.recommendation')}</p>
    </div>
  );
}

function SecretField({
  provider,
  name,
  saved,
  onStatus,
}: {
  provider: StrixProviderId;
  name: StrixSecretName;
  saved: boolean;
  onStatus: (status: StrixSecretStatus) => void;
}) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const id = `strix-secret-${name}`;

  const save = async () => {
    setBusy(true);
    setError(false);
    try {
      const result = await window.electronAPI.strix.saveSecret(provider, name, value);
      if (result.success) {
        onStatus(result.data);
        setValue('');
        setShow(false);
      } else {
        setError(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.strix.clearSecret(provider, name);
      if (result.success) onStatus(result.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {t(`general.securityQaLlm.secrets.${name}`)}
        {provider === 'local' ? ` ${t('general.securityQaLlm.optional')}` : ''}
      </Label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={id}
            type={show ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            className="pr-11 font-mono"
            placeholder={saved ? t('general.securityQaLlm.replacePlaceholder') : ''}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(false);
            }}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? t('general.securityQaLlm.hide') : t('general.securityQaLlm.show')}
            className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button type="button" onClick={() => void save()} disabled={!value.trim() || busy}>
          {t('general.securityQaLlm.save')}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{t('general.securityQaLlm.saveFailed')}</p>
      ) : saved ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">{t('general.securityQaLlm.saved')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void clear()} disabled={busy}>
            {t('general.securityQaLlm.remove')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
