/**
 * PipelineField - which pipeline the task runs (shared/pipeline.ts)
 *
 * "Auto" lets the app decide when the task starts; the other three are the user's
 * choice and always win. Used in TaskCreationWizard and TaskEditDialog.
 */
import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { PipelineChoice } from '../../../shared/pipeline';

export const PIPELINE_CHOICES: PipelineChoice[] = ['auto', 'single', 'short', 'full'];

interface PipelineFieldProps {
  value: PipelineChoice;
  onChange: (value: PipelineChoice) => void;
  disabled?: boolean;
  /** Optional ID prefix for form elements (for accessibility) */
  idPrefix?: string;
}

export function PipelineField({ value, onChange, disabled = false, idPrefix = '' }: PipelineFieldProps) {
  const { t } = useTranslation('tasks');
  const id = `${idPrefix ? `${idPrefix}-` : ''}pipeline`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {t('pipeline.label')}
      </Label>
      <Select value={value} onValueChange={(next) => onChange(next as PipelineChoice)} disabled={disabled}>
        <SelectTrigger id={id} className="h-9" aria-describedby={`${id}-help`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PIPELINE_CHOICES.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {t(`pipeline.options.${choice}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t(`pipeline.optionHelp.${value}`)}
      </p>
    </div>
  );
}
