import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import type { AppSettings } from '../../../shared/types';
import { MemoryConfigPanel, type MemoryPanelConfig } from '../shared/MemoryConfigPanel';
import { SettingsSection } from './SettingsSection';

interface MemorySettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/** App settings → the panel's shape. Pure — tested directly. */
export function toMemoryPanelConfig(settings: AppSettings): MemoryPanelConfig {
  return {
    enabled: settings.memoryEnabled !== false,
    embeddingProvider: settings.memoryEmbeddingProvider ?? 'ollama',
    openaiApiKey: settings.globalOpenAIApiKey ?? '',
    openaiEmbeddingModel: settings.memoryOpenaiEmbeddingModel ?? '',
    azureOpenaiApiKey: settings.memoryAzureApiKey ?? '',
    azureOpenaiBaseUrl: settings.memoryAzureBaseUrl ?? '',
    azureOpenaiEmbeddingDeployment: settings.memoryAzureEmbeddingDeployment ?? '',
    voyageApiKey: settings.memoryVoyageApiKey ?? '',
    voyageEmbeddingModel: settings.memoryVoyageEmbeddingModel ?? '',
    googleApiKey: settings.globalGoogleApiKey ?? '',
    googleEmbeddingModel: settings.memoryGoogleEmbeddingModel ?? '',
    ollamaBaseUrl: settings.ollamaBaseUrl ?? 'http://localhost:11434',
    ollamaEmbeddingModel: settings.memoryOllamaEmbeddingModel ?? 'qwen3-embedding:4b',
    ollamaEmbeddingDim: settings.memoryOllamaEmbeddingDim ?? 2560,
  };
}

/** Panel changes → the app settings keys the memory engine reads. Pure — tested directly. */
export function applyMemoryPanelChange(settings: AppSettings, updates: Partial<MemoryPanelConfig>): AppSettings {
  const next: AppSettings = { ...settings };
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    next[key] = value;
  };
  if ('enabled' in updates) set('memoryEnabled', updates.enabled);
  if ('embeddingProvider' in updates) set('memoryEmbeddingProvider', updates.embeddingProvider);
  if ('openaiApiKey' in updates) set('globalOpenAIApiKey', updates.openaiApiKey || undefined);
  if ('openaiEmbeddingModel' in updates) set('memoryOpenaiEmbeddingModel', updates.openaiEmbeddingModel || undefined);
  if ('azureOpenaiApiKey' in updates) set('memoryAzureApiKey', updates.azureOpenaiApiKey || undefined);
  if ('azureOpenaiBaseUrl' in updates) set('memoryAzureBaseUrl', updates.azureOpenaiBaseUrl || undefined);
  if ('azureOpenaiEmbeddingDeployment' in updates) set('memoryAzureEmbeddingDeployment', updates.azureOpenaiEmbeddingDeployment || undefined);
  if ('voyageApiKey' in updates) set('memoryVoyageApiKey', updates.voyageApiKey || undefined);
  if ('voyageEmbeddingModel' in updates) set('memoryVoyageEmbeddingModel', updates.voyageEmbeddingModel || undefined);
  if ('googleApiKey' in updates) set('globalGoogleApiKey', updates.googleApiKey || undefined);
  if ('googleEmbeddingModel' in updates) set('memoryGoogleEmbeddingModel', updates.googleEmbeddingModel || undefined);
  if ('ollamaBaseUrl' in updates) set('ollamaBaseUrl', updates.ollamaBaseUrl || undefined);
  if ('ollamaEmbeddingModel' in updates) set('memoryOllamaEmbeddingModel', updates.ollamaEmbeddingModel || undefined);
  if ('ollamaEmbeddingDim' in updates) set('memoryOllamaEmbeddingDim', updates.ollamaEmbeddingDim || undefined);
  return next;
}

/**
 * Settings → Memory: the one project memory the agents use. Same settings as the
 * onboarding step; saved with the dialog's Save button.
 */
export function MemorySettings({ settings, onSettingsChange }: MemorySettingsProps) {
  const { t } = useTranslation('settings');
  return (
    <SettingsSection title={t('sections.memory.title')} description={t('sections.memory.description')}>
      <div className="space-y-6">
        <div className="flex items-start gap-3 border-l-2 border-foreground bg-muted/30 p-4">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{t('memorySettings.howItWorks')}</p>
            <p>{t('memorySettings.whereToSee')}</p>
          </div>
        </div>
        <MemoryConfigPanel
          config={toMemoryPanelConfig(settings)}
          onChange={(updates) => onSettingsChange(applyMemoryPanelChange(settings, updates))}
        />
      </div>
    </SettingsSection>
  );
}
