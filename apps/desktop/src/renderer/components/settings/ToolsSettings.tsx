import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { ToolsChecklist } from '../tools-check';

/**
 * Settings → Tools: the optional external tools the pipeline uses and whether
 * this Mac has them. Read-only; nothing here is saved.
 */
export function ToolsSettings() {
  const { t } = useTranslation('settings');
  return (
    <SettingsSection title={t('tools.title')} description={t('tools.description')}>
      <ToolsChecklist />
    </SettingsSection>
  );
}
