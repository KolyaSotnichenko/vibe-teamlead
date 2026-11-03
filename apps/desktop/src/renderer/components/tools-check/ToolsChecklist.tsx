/**
 * Which external tools this Mac has, what each is for, and how to get the
 * missing ones. Shared by the onboarding "Tools" step and Settings → Tools.
 *
 * Design system: one ink frame with hairline rows, status as glyph + word
 * (never colour alone), vermilion only on rows that need the user's attention,
 * commands in IBM Plex Mono.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, RotateCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settings-store';
import type { ToolCheck, ToolStatus } from '../../../shared/types';
import {
  AREA_ORDER,
  START_DOCKER_COMMAND,
  TOOL_NAMES,
  areaOf,
  summarize,
  type AreaSummary,
  type ToolArea,
} from './tool-meta';
import { useToolsCheck } from './useToolsCheck';

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const GLYPH: Record<ToolStatus, string> = {
  bundled: '■',
  ready: '✓',
  not_running: '◧',
  missing: '✕',
};

function needsAttention(tool: ToolCheck): boolean {
  return tool.status === 'missing' || tool.status === 'not_running';
}

function StatusChip({ tool }: { tool: ToolCheck }) {
  const { t } = useTranslation('settings');
  const required = !tool.optional && tool.status === 'missing';
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.04em]',
        tool.status === 'bundled' && 'border border-transparent bg-accent text-muted-foreground',
        tool.status === 'ready' && 'border border-foreground text-foreground',
        needsAttention(tool) && !required && 'border border-destructive text-destructive',
        required && 'border border-destructive bg-destructive text-destructive-foreground'
      )}
    >
      <span aria-hidden="true">{GLYPH[tool.status]}</span>
      {t(`tools.status.${tool.status}`)}
    </span>
  );
}

/** Mono command with an attached Copy button (44px tall, a primary action of the row). */
function CommandBox({ command, toolName }: { command: string; toolName: string }) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="flex min-w-0 flex-1 items-stretch border border-foreground">
      <code className="flex min-h-11 min-w-0 flex-1 select-all items-center overflow-x-auto whitespace-nowrap bg-muted px-3 font-mono text-[13px] text-foreground">
        <span aria-hidden="true" className="mr-2 text-muted-foreground">
          $
        </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={t('tools.copyFor', { tool: toolName })}
        className={cn(
          'min-h-11 min-w-[76px] shrink-0 border-l border-foreground px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent motion-reduce:transition-none',
          FOCUS
        )}
      >
        <span aria-live="polite">
          {copied === 'ok' ? t('tools.copied') : copied === 'failed' ? t('tools.copyFailed') : t('tools.copy')}
        </span>
      </button>
    </div>
  );
}

function GuideLink({ url, toolName }: { url: string; toolName: string }) {
  const { t } = useTranslation('settings');
  return (
    <button
      type="button"
      onClick={() => window.electronAPI?.openExternal?.(url)}
      aria-label={t('tools.guideFor', { tool: toolName })}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-1 px-1 text-sm font-medium text-foreground underline underline-offset-4 hover:decoration-2',
        FOCUS
      )}
    >
      {t('tools.guide')}
      <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}

function ToolRow({ tool }: { tool: ToolCheck }) {
  const { t } = useTranslation('settings');
  const name = TOOL_NAMES[tool.id];
  const attention = needsAttention(tool);
  const data = [tool.version, tool.path].filter(Boolean).join(' · ');
  const fixCommand = tool.status === 'not_running' ? START_DOCKER_COMMAND : tool.status === 'missing' ? tool.installCommand : undefined;

  return (
    <li className={cn('border-b border-border px-4 py-3 last:border-b-0', attention && 'border-l-2 border-l-destructive pl-[14px]')}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-foreground">{name}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{t(`tools.purpose.${tool.id}`)}</p>
        </div>
        <StatusChip tool={tool} />
      </div>

      {data && !attention && (
        <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground">
          {data}
        </p>
      )}

      {attention && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-foreground">
            {tool.status === 'not_running'
              ? t('tools.fix.startDocker')
              : tool.optional
                ? t(`tools.skippedWithout.${tool.neededFor}`)
                : t('tools.fix.reinstall')}
          </p>
          {(fixCommand || tool.installUrl) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {fixCommand && <CommandBox command={fixCommand} toolName={name} />}
              {tool.installUrl && tool.status === 'missing' && <GuideLink url={tool.installUrl} toolName={name} />}
            </div>
          )}
          {tool.status === 'not_running' && data && <p className="truncate font-mono text-xs text-muted-foreground">{data}</p>}
        </div>
      )}
    </li>
  );
}

function SummaryLine({ summary, securityQaOn }: { summary: AreaSummary[]; securityQaOn: boolean }) {
  const { t, i18n } = useTranslation('settings');
  const list = (items: string[]) => {
    try {
      return new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(items);
    } catch {
      return items.join(', ');
    }
  };
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {summary.map(({ area, blockers }) => {
        const ready = blockers.length === 0;
        // An optional check that is switched off needs nothing from the user: neutral, not a signal
        const optionalOff = area === 'security_qa' && !securityQaOn;
        const needs = list(
          blockers.map((b) => (b.notRunning ? t('tools.summary.running', { tool: TOOL_NAMES[b.id] }) : TOOL_NAMES[b.id]))
        );
        return (
          <li key={area} className="flex items-baseline gap-1.5">
            <span aria-hidden="true" className={cn('font-mono text-xs', ready || optionalOff ? 'text-muted-foreground' : 'text-destructive')}>
              {ready ? '✓' : optionalOff ? '–' : '✕'}
            </span>
            <span className="font-medium text-foreground">{t(`tools.areas.${area}.title`)}:</span>
            <span className={ready ? 'text-muted-foreground' : 'text-foreground'}>
              {ready ? t('tools.summary.ready') : t('tools.summary.needs', { list: needs })}
              {area === 'security_qa' && !securityQaOn && ` ${t('tools.summary.securityQaOff')}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "Checking this Mac…" — the design-system Pending row: breathing ink square, no spinner. */
function Pending({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex items-center gap-3 border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
      <span aria-hidden="true" className="vt-breathe h-2 w-2 shrink-0 bg-foreground" />
      {label}
    </div>
  );
}

interface ToolsChecklistProps {
  className?: string;
}

export function ToolsChecklist({ className }: ToolsChecklistProps) {
  const { t } = useTranslation('settings');
  const { tools, checking, error, recheck } = useToolsCheck();
  const securityQaOn = useSettingsStore((s) => s.settings?.securityQaEnabled === true);

  const groups = AREA_ORDER.map((area) => ({ area, items: (tools ?? []).filter((tool) => areaOf(tool) === area) })).filter(
    (g) => g.items.length > 0
  );

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1" aria-live="polite">
          {checking ? (
            <Pending label={tools ? t('tools.checkingAgain') : t('tools.checking')} />
          ) : error ? (
            <p role="alert" className="border-l-2 border-destructive bg-muted px-3 py-2 text-sm text-foreground">
              {t('tools.checkFailed')} <span className="font-mono text-xs text-muted-foreground">{error}</span>
            </p>
          ) : tools ? (
            <SummaryLine summary={summarize(tools)} securityQaOn={securityQaOn} />
          ) : null}
        </div>
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          className={cn(
            'inline-flex min-h-11 shrink-0 items-center gap-2 border border-foreground px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50 motion-reduce:transition-none',
            FOCUS
          )}
        >
          <RotateCw aria-hidden="true" className="h-4 w-4" />
          {t('tools.checkAgain')}
        </button>
      </div>

      {groups.length > 0 && (
        <div className={cn('border border-foreground', checking && 'opacity-60')} aria-busy={checking || undefined}>
          {groups.map(({ area, items }) => (
            <section key={area} aria-labelledby={`tools-area-${area}`} className="border-b border-foreground last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border bg-muted px-4 py-2">
                <h4 id={`tools-area-${area}`} className="text-[12px] font-semibold uppercase tracking-[0.06em] text-foreground">
                  {t(`tools.areas.${area satisfies ToolArea}.title`)}
                </h4>
                <span className="text-xs text-muted-foreground">{t(`tools.areas.${area}.when`)}</span>
              </div>
              <ul>
                {items.map((tool) => (
                  <ToolRow key={tool.id} tool={tool} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">{t('tools.optionalNote')}</p>
    </div>
  );
}
