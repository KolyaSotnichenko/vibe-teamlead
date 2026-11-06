/**
 * The project's checks, which the app runs itself before QA and after a merge.
 * Kept in the app's settings and not in the repository: an agent must not be able
 * to change what checks its work.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectSettings } from '../../../shared/types';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';

/** KEY=value per line; anything else is skipped. Pure. */
export function parseEnvLines(text: string): Record<string, string> {
  const entries: [string, string][] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) entries.push([match[1], match[2]]);
  }
  return Object.fromEntries(entries);
}

const envText = (env: Record<string, string> | undefined) => Object.entries(env ?? {}).map(([name, value]) => `${name}=${value}`).join('\n');

export function VerificationSection({ settings, setSettings }: { settings: ProjectSettings; setSettings: (settings: ProjectSettings) => void }) {
  const { t } = useTranslation(['settings']);
  const [commands, setCommands] = useState((settings.verifyCommands ?? []).join('\n'));
  const [env, setEnv] = useState(envText(settings.verifyEnv));
  const enabled = settings.verifyEnabled !== false;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('settings:verification.title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings:verification.description')}</p>
        </div>
        <Switch checked={enabled} aria-label={t('settings:verification.title')} onCheckedChange={(checked) => setSettings({ ...settings, verifyEnabled: checked })} />
      </div>
      {enabled && (
        <>
          <div className="space-y-1">
            <Label htmlFor="verify-commands" className="font-normal text-foreground">{t('settings:verification.commands')}</Label>
            <Textarea
              id="verify-commands"
              rows={3}
              value={commands}
              onChange={(event) => setCommands(event.target.value)}
              onBlur={() => {
                const list = commands.split('\n').map((line) => line.trim()).filter(Boolean);
                setSettings({ ...settings, verifyCommands: list.length ? list : undefined });
              }}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">{t('settings:verification.commandsHint')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="verify-env" className="font-normal text-foreground">{t('settings:verification.env')}</Label>
            <Textarea
              id="verify-env"
              rows={3}
              value={env}
              onChange={(event) => setEnv(event.target.value)}
              onBlur={() => setSettings({ ...settings, verifyEnv: parseEnvLines(env) })}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">{t('settings:verification.envHint')}</p>
          </div>
        </>
      )}
    </section>
  );
}
