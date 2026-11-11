import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { VercelPanel } from './VercelPanel';

/** Settings → Vercel: the account the app deploys to. */
export function VercelSettings() {
  const { t } = useTranslation('settings');
  return (
    <SettingsSection title={t('vercel.title')} description={t('vercel.description')}>
      <VercelPanel />
    </SettingsSection>
  );
}
