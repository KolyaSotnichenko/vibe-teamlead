import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { AVAILABLE_MODELS, LEGACY_MODEL_LABELS, REMOVED_PROVIDER_MODELS } from '../../../shared/constants';
import type { ClaudeModelList } from '../../../shared/types';
import { useEndpointModels } from '../../hooks/useEndpointModels';
import { cn } from '../../lib/utils';
import { Combobox, type ComboboxOption } from '../ui/combobox';

interface ClaudeModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Shown when no model is chosen (default: "Select a model") */
  placeholder?: string;
}

/** Host of an endpoint URL, for group headers ("localhost:11434"). */
function endpointName(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Picker options: the built-in shorthands, the models the endpoint lists,
 * and the current value if it is neither (a model id typed earlier).
 * With a custom endpoint (e.g. Ollama) its models come first.
 */
export function buildModelOptions(
  value: string,
  list: ClaudeModelList | null,
  labels: { builtIn: string; endpoint: (name: string) => string; current: string },
): ComboboxOption[] {
  const builtIn: ComboboxOption[] = AVAILABLE_MODELS.map((m) => ({ value: m.value, label: m.label, group: labels.builtIn }));
  const endpointGroup = list ? labels.endpoint(endpointName(list.endpoint)) : '';
  const listed: ComboboxOption[] = (list?.models ?? []).map((m) => ({
    value: m.id,
    label: m.displayName && m.displayName !== m.id ? `${m.displayName} · ${m.id}` : m.id,
    group: endpointGroup,
  }));
  const options = list?.custom ? [...listed, ...builtIn] : [...builtIn, ...listed];

  const current = value?.trim();
  if (current && !REMOVED_PROVIDER_MODELS.has(current) && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: LEGACY_MODEL_LABELS[current] ?? current, group: labels.current });
  }
  return options;
}

/**
 * Model picker: built-in Claude models, the live list from the configured
 * endpoint (Anthropic API or the base URL, e.g. Ollama), or any typed id.
 * A stored model of a removed provider shows the placeholder.
 */
export function ClaudeModelSelect({ value, onChange, disabled, id, className, placeholder }: ClaudeModelSelectProps) {
  const { t } = useTranslation('settings');
  const { list, loading, refresh } = useEndpointModels();

  const options = useMemo(
    () =>
      buildModelOptions(value, list, {
        builtIn: t('modelPicker.builtIn'),
        endpoint: (name) => t('modelPicker.fromEndpoint', { endpoint: name }),
        current: t('modelPicker.current'),
      }),
    [value, list, t],
  );

  const status = loading
    ? t('modelPicker.loading')
    : list?.error
      ? t('modelPicker.error', { error: list.error })
      : list
        ? t('modelPicker.count', { count: list.models.length, endpoint: endpointName(list.endpoint) })
        : '';

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <span className={cn('min-w-0 truncate text-xs', list?.error ? 'text-destructive' : 'text-muted-foreground')} title={status}>
        {status}
      </span>
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} aria-hidden="true" />
        {t('modelPicker.refresh')}
      </button>
    </div>
  );

  return (
    <Combobox
      id={id}
      className={className}
      value={value && !REMOVED_PROVIDER_MODELS.has(value) ? value : ''}
      onValueChange={onChange}
      options={options}
      disabled={disabled}
      placeholder={placeholder ?? t('agentProfile.selectModel')}
      searchPlaceholder={t('modelPicker.search')}
      emptyMessage={t('modelPicker.empty')}
      customValueLabel={(typed) => t('modelPicker.useCustom', { id: typed })}
      footer={footer}
    />
  );
}
