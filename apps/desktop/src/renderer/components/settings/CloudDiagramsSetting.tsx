/**
 * Settings → Agents: cloud architecture diagrams with TerraVision (experimental,
 * off by default) and what is installed for it. Nothing is installed for the user.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import type { AppSettings, CloudToolsState } from '../../../shared/types';

interface Props {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export function CloudDiagramsSetting({ settings, onSettingsChange }: Props) {
  const { t } = useTranslation(['cloud']);
  const enabled = settings.cloudDiagramsEnabled === true;
  const [tools, setTools] = useState<CloudToolsState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    window.electronAPI.cloudArchitecture.tools().then((result) => {
      if (!cancelled && result.success && result.data) setTools(result.data);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return (
    <div className="space-y-2 max-w-md">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="cloudDiagramsEnabled" className="text-sm font-medium text-foreground">
            {t('cloud:settings.title')}
          </Label>
          <p className="text-sm text-muted-foreground">{t('cloud:settings.description')}</p>
        </div>
        <Switch
          id="cloudDiagramsEnabled"
          checked={enabled}
          onCheckedChange={(checked) => onSettingsChange({ ...settings, cloudDiagramsEnabled: checked })}
        />
      </div>
      {enabled && (
        <div role="status" className="border-l-2 border-foreground bg-muted px-3 py-2 text-xs text-muted-foreground">
          {!tools ? (
            <p>{t('cloud:settings.checking')}</p>
          ) : (
            <>
              <p>{tools.ready ? t(tools.drawFromCode ? 'cloud:settings.ready' : 'cloud:settings.readyNoCode') : t('cloud:settings.notReady')}</p>
              {tools.missing.length > 0 && (
                <>
                  <p className="mt-1">{t('cloud:settings.missing')}</p>
                  <ul className="mt-1 space-y-1">
                    {tools.missing.map((tool) => (
                      <li key={tool}>
                        <span className="text-foreground">{t(`cloud:settings.tools.${tool}`)}</span>
                        {' '}
                        <code className="font-mono">{tools.hints[tool]}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
