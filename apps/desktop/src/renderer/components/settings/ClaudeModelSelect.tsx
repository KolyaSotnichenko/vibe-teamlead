import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODELS } from '../../../shared/constants';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface ClaudeModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Claude model picker (haiku / sonnet / opus shorthands).
 * A stored value that is not a known Claude model (e.g. from a removed
 * provider) shows the placeholder so the user picks a Claude model.
 */
export function ClaudeModelSelect({ value, onChange, disabled, id, className }: ClaudeModelSelectProps) {
  const { t } = useTranslation('settings');
  const known = AVAILABLE_MODELS.some((m) => m.value === value);

  return (
    <Select value={known ? value : undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder={t('agentProfile.selectModel')} />
      </SelectTrigger>
      <SelectContent>
        {AVAILABLE_MODELS.map((model) => (
          <SelectItem key={model.value} value={model.value}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
