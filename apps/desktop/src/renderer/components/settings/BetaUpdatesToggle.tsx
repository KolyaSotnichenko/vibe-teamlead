/**
 * The beta updates setting. On a pre-release it can't say "off": that version follows
 * pre-releases whatever the setting holds, so the switch shows what really happens.
 */

import { useTranslation } from 'react-i18next';
import { isPrereleaseVersion } from '../../../shared/utils/update-channel';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';

export function BetaUpdatesToggle({ version, enabled, onChange }: { version: string; enabled: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation('settings');
  const prerelease = isPrereleaseVersion(version);

  return (
    <div className="flex items-center justify-between p-4 rounded-lg border border-border">
      <div className="space-y-1">
        <Label className="font-medium text-foreground">{t('updates.betaUpdates')}</Label>
        <p className="text-sm text-muted-foreground">
          {t(prerelease ? 'updates.betaUpdatesPrerelease' : 'updates.betaUpdatesDescription')}
        </p>
      </div>
      <Switch checked={prerelease || enabled} disabled={prerelease} aria-label={t('updates.betaUpdates')} onCheckedChange={onChange} />
    </div>
  );
}
