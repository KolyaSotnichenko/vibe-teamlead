/**
 * Settings → Project → Queue: which pipeline the project's tasks run when they choose none,
 * how many tasks may be under way at once, whether tasks QA approved merge by themselves, and whether
 * a failed preview start asks the agent that fixes it by itself. Edits the project's settings; they save with the section, and
 * a limit out of range is refused then (`lib/queue-settings.ts`).
 */
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS } from '../../../shared/utils/task-slots';
import { maxParallelError } from '../../lib/queue-settings';
import { PipelineField } from '../task-form/PipelineField';
import type { ProjectSettings } from '../../../shared/types';

interface QueueSettingsProps {
  settings: ProjectSettings;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

export function QueueSettings({ settings, setSettings }: QueueSettingsProps) {
  const { t } = useTranslation(['tasks']);
  const maxParallel = settings.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
  const autoMerge = settings.autoMerge === true;
  const error = maxParallelError(maxParallel);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Empty is allowed while typing; it is refused on save
    const value = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
    if (Number.isNaN(value)) return;
    setSettings((prev) => ({ ...prev, maxParallelTasks: value }));
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <PipelineField
          label={t('tasks:queue.settings.defaultPipelineLabel')}
          value={settings.defaultPipeline}
          // Auto is the absence of a default
          onChange={(choice) => setSettings((prev) => ({ ...prev, defaultPipeline: choice ?? 'auto' }))}
          idPrefix="project"
        />
        <p className="text-sm text-muted-foreground">{t('tasks:queue.settings.defaultPipelineHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="maxParallel">{t('tasks:queue.settings.maxParallelLabel')}</Label>
        <Input
          id="maxParallel"
          type="number"
          min={1}
          max={MAX_PARALLEL_TASKS}
          value={maxParallel}
          onChange={handleInputChange}
          aria-invalid={error !== null}
          className="w-32"
        />
        {error && <p className="text-sm text-destructive">{t(error)}</p>}
        <p className="text-sm text-muted-foreground">{t('tasks:queue.settings.hint')}</p>
        {maxParallel > 1 && (
          <p role="alert" className="border-l-2 border-l-[var(--vt-signal)] pl-3 text-sm text-foreground">
            {t('tasks:queue.settings.parallelWarning')}
          </p>
        )}
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="autoMerge">{t('tasks:queue.settings.autoMergeLabel')}</Label>
          <p className="text-sm text-muted-foreground">{t('tasks:queue.settings.autoMergeHint')}</p>
        </div>
        <Switch
          id="autoMerge"
          checked={autoMerge}
          onCheckedChange={(on) =>
            // The preview hold only means something with auto-merge on
            setSettings((prev) => (on ? { ...prev, autoMerge: true } : { ...prev, autoMerge: false, previewBeforeAutoMerge: false }))
          }
        />
      </div>

      {autoMerge && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="previewHold">{t('tasks:queue.settings.previewHoldLabel')}</Label>
            <p className="text-sm text-muted-foreground">{t('tasks:queue.settings.previewHoldHint')}</p>
          </div>
          <Switch
            id="previewHold"
            checked={settings.previewBeforeAutoMerge === true}
            onCheckedChange={(on) => setSettings((prev) => ({ ...prev, previewBeforeAutoMerge: on }))}
          />
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="previewFix">{t('tasks:queue.settings.previewFixLabel')}</Label>
          <p className="text-sm text-muted-foreground">{t('tasks:queue.settings.previewFixHint')}</p>
        </div>
        <Switch
          id="previewFix"
          // Absent means on: a project that never chose gets the agent
          checked={settings.previewFixAutomatically !== false}
          onCheckedChange={(on) => setSettings((prev) => ({ ...prev, previewFixAutomatically: on }))}
        />
      </div>
    </div>
  );
}
