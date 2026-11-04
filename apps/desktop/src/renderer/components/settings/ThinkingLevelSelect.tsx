import { useTranslation } from 'react-i18next';
import {
  getReasoningTypeForModel,
  REASONING_TYPE_BADGES,
  THINKING_LEVELS,
} from '@shared/constants/models';
import type { ReasoningType } from '@shared/constants/models';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { thinkingLabel } from '../../lib/agent-labels';

interface ThinkingLevelSelectProps {
  value: string;
  onChange: (value: string) => void;
  modelValue: string;
  disabled?: boolean;
}

/**
 * Model-aware thinking level selector.
 * Renders different controls based on the Claude model's reasoning type:
 *   - 'none': disabled select showing "(No thinking)"
 *   - others: Low / Medium / High dropdown
 */
export function ThinkingLevelSelect({
  value,
  onChange,
  modelValue,
  disabled,
}: ThinkingLevelSelectProps) {
  const { t } = useTranslation('settings');

  const reasoningType: ReasoningType = getReasoningTypeForModel(modelValue);

  const badgeConfig = REASONING_TYPE_BADGES[reasoningType];

  // Render the badge with a tooltip when the reasoning type warrants one
  const renderBadge = () => {
    if (!badgeConfig) return null;
    const badgeLabel = t(badgeConfig.i18nKey as Parameters<typeof t>[0]);
    const tooltipText = t(
      `agentProfile.reasoning.badgeTooltip.${reasoningType}` as Parameters<typeof t>[0],
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex cursor-help items-center',
              'bg-primary/10 px-1.5 leading-4',
              'text-[9px] font-medium text-primary',
            )}
          >
            {badgeLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    );
  };

  // ── No thinking available ─────────────────────────────────────────────────
  if (reasoningType === 'none') {
    return (
      <div className="space-y-1">
        <div className="flex h-5 items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {t('agentProfile.thinkingLevel')}
          </span>
          {renderBadge()}
        </div>
        <Select value={value} onValueChange={onChange} disabled>
          <SelectTrigger>
            <SelectValue placeholder={t('agentProfile.reasoning.noThinking')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={value || 'low'}>
              {t('agentProfile.reasoning.noThinking')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }

  // ── Standard Low / Medium / High dropdown ────────────────────────────────
  const levels = THINKING_LEVELS.filter((l) => l.value !== 'xhigh');

  return (
    <div className="space-y-1">
      <div className="flex h-5 items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t('agentProfile.thinkingLevel')}
        </span>
        {renderBadge()}
      </div>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((level) => (
            <SelectItem key={level.value} value={level.value}>
              {thinkingLabel(t, level.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
