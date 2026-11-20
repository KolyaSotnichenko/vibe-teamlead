/**
 * PipelineField - which pipeline a task runs (shared/pipeline.ts)
 *
 * In a task: nothing chosen means "as the project says" (its default pipeline, or Auto when
 * it has none); "Auto" lets the app decide when the task starts; the other three are the
 * user's choice and always win. Also the project's own default in Settings → Project → Queue.
 * Used in TaskCreationWizard, TaskEditDialog and QueueSettings.
 */
import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { isPipelineKind, type PipelineChoice, type PipelineKind } from '../../../shared/pipeline';

const KINDS: PipelineKind[] = ['single', 'short', 'full'];
/** The option that stands for "nothing chosen" where the project has a default pipeline */
const AS_PROJECT = 'project';

/** What the field shows for a stored choice. Pure. */
export function shownPipelineOption(value: PipelineChoice | undefined, projectDefault: PipelineKind | undefined): string {
  if (isPipelineKind(value)) return value;
  return value === undefined && projectDefault ? AS_PROJECT : 'auto';
}

/** The choice to store for an option. Without a project default, Auto is simply nothing chosen. Pure. */
export function pipelineChoiceOf(option: string, projectDefault: PipelineKind | undefined): PipelineChoice | undefined {
  if (isPipelineKind(option)) return option;
  return option === 'auto' && projectDefault ? 'auto' : undefined;
}

interface PipelineFieldProps {
  value: PipelineChoice | undefined;
  onChange: (value: PipelineChoice | undefined) => void;
  /** The project's default pipeline, when it has one: the field then offers "as in the project" */
  projectDefault?: PipelineKind;
  /** Instead of "Pipeline" */
  label?: string;
  disabled?: boolean;
  /** Optional ID prefix for form elements (for accessibility) */
  idPrefix?: string;
}

export function PipelineField({ value, onChange, projectDefault, label, disabled = false, idPrefix = '' }: PipelineFieldProps) {
  const { t } = useTranslation('tasks');
  const id = `${idPrefix ? `${idPrefix}-` : ''}pipeline`;
  const options = [...(projectDefault ? [AS_PROJECT] : []), 'auto', ...KINDS];
  const shown = shownPipelineOption(value, projectDefault);
  const named = projectDefault ? { name: t(`pipeline.options.${projectDefault}`) } : undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label ?? t('pipeline.label')}
      </Label>
      <Select value={shown} onValueChange={(option) => onChange(pipelineChoiceOf(option, projectDefault))} disabled={disabled}>
        <SelectTrigger id={id} className="h-9" aria-describedby={`${id}-help`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`pipeline.options.${option}`, named)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t(`pipeline.optionHelp.${shown}`, named)}
      </p>
    </div>
  );
}
