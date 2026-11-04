/**
 * Tokens spent on the active project, next to the "+" in the project tab bar.
 * A compact mono readout; the popover breaks it down (kinds of tokens, agents,
 * what the dollar figure covers).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectUsageSummary } from '../../shared/types';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const REFRESH_MS = 15_000;

/** 18_430_000 → "18.4M", 912_000 → "912K", 840 → "840". Pure. */
export function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

/** $23.47; under a cent shows "<$0.01". Pure. */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Agent types grouped into the roles people see on the board. Pure. */
export function roleOf(agentType: string): 'spec' | 'architect' | 'planner' | 'coder' | 'qa' | 'qaFixer' | 'other' {
  if (agentType.startsWith('spec_')) return 'spec';
  if (agentType === 'architect') return 'architect';
  if (agentType === 'planner' || agentType === 'followup_planner') return 'planner';
  if (agentType === 'coder') return 'coder';
  if (agentType === 'qa_reviewer') return 'qa';
  if (agentType === 'qa_fixer') return 'qaFixer';
  return 'other';
}

const ROLE_ORDER = ['spec', 'architect', 'planner', 'coder', 'qa', 'qaFixer', 'other'] as const;

function useProjectUsage(projectId: string | null): ProjectUsageSummary | null {
  const [usage, setUsage] = useState<ProjectUsageSummary | null>(null);
  const load = useCallback(() => {
    if (!projectId) return;
    window.electronAPI?.usage
      ?.get(projectId)
      .then((r) => r?.success && r.data && setUsage(r.data))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    setUsage(null);
    load();
    // Sessions append as they end: refresh while the window is visible
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  return usage;
}

export function ProjectUsage({ projectId }: { projectId: string | null }) {
  const { t, i18n } = useTranslation('common');
  const usage = useProjectUsage(projectId);
  if (!usage || usage.sessions === 0) return null;

  const hasCost = usage.pricedTokens > 0;
  const kinds = [
    { key: 'input', value: usage.input, tone: 'bg-foreground' },
    { key: 'output', value: usage.output, tone: 'bg-foreground/60' },
    { key: 'cacheRead', value: usage.cacheRead, tone: 'bg-foreground/25' },
    { key: 'cacheWrite', value: usage.cacheWrite, tone: 'bg-foreground/45' },
  ] as const;

  const roles = new Map<string, number>();
  for (const [agent, tokens] of Object.entries(usage.byAgent)) {
    const role = roleOf(agent);
    roles.set(role, (roles.get(role) ?? 0) + tokens);
  }
  const roleRows = ROLE_ORDER.filter((r) => roles.get(r)).map((r) => ({ role: r, tokens: roles.get(r) ?? 0 }));
  const maxRole = Math.max(...roleRows.map((r) => r.tokens), 1);
  const since = usage.since ? new Date(usage.since).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' }) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="electron-no-drag flex h-8 items-center gap-2 px-2 font-mono text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('usage.ariaLabel', { tokens: compactTokens(usage.totalTokens) })}
        >
          <span>
            {compactTokens(usage.totalTokens)}
            <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">{t('usage.tokensShort')}</span>
          </span>
          {hasCost && (
            <>
              <span aria-hidden className="h-3 w-px bg-border" />
              <span>{formatUsd(usage.costUsd)}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-0">
        {/* Total */}
        <div className="border-b border-border px-4 pt-3 pb-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t('usage.title')}</span>
            {since && <span className="font-mono text-[11px] text-muted-foreground">{t('usage.since', { date: since })}</span>}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-[22px] font-medium leading-none tabular-nums text-foreground">
              {usage.totalTokens.toLocaleString(i18n.language)}
            </span>
            <span className="text-xs text-muted-foreground">{t('usage.tokens')}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {t('usage.sessions', { count: usage.sessions })}
          </div>
          {/* Kinds of tokens: one bar, then the legend */}
          <div className="mt-3 flex h-1.5 w-full bg-muted" aria-hidden>
            {kinds.map((k) =>
              k.value > 0 ? <span key={k.key} className={k.tone} style={{ width: `${(k.value / usage.totalTokens) * 100}%` }} /> : null,
            )}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            {kinds.map((k) => (
              <div key={k.key} className="flex items-center justify-between gap-2 text-xs">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden className={cn('h-2 w-2', k.tone)} />
                  {t(`usage.kinds.${k.key}`)}
                </dt>
                <dd className="font-mono tabular-nums text-foreground">{compactTokens(k.value)}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* By agent */}
        {roleRows.length > 0 && (
          <div className="border-b border-border px-4 py-3">
            <div className="mb-2 text-xs text-muted-foreground">{t('usage.byAgent')}</div>
            <ul className="space-y-1.5">
              {roleRows.map(({ role, tokens }) => (
                <li key={role} className="grid grid-cols-[88px_1fr_44px] items-center gap-2 text-xs">
                  <span className="truncate text-foreground">{t(`usage.roles.${role}`)}</span>
                  <span className="h-1 bg-muted" aria-hidden>
                    <span className="block h-full bg-foreground" style={{ width: `${(tokens / maxRole) * 100}%` }} />
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">{compactTokens(tokens)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* What the dollars cover */}
        <div className="space-y-1.5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {hasCost && (
            <p>
              <span className="font-mono text-foreground">{formatUsd(usage.costUsd)}</span>{' '}
              {t('usage.costApi', { tokens: compactTokens(usage.pricedTokens) })}
            </p>
          )}
          {usage.gatewayTokens > 0 && (
            <p>{t('usage.costGateway', { tokens: compactTokens(usage.gatewayTokens), gateway: usage.gateways.join(', ') })}</p>
          )}
          {usage.subscriptionTokens > 0 && (
            <p>{t('usage.costSubscription', { tokens: compactTokens(usage.subscriptionTokens) })}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
