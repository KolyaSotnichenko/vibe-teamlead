/**
 * What the workspace files say right now, one row each with a shortcut:
 * acceptance criteria (from spec.md + qa_report.md), architecture, security
 * (gates before QA, Strix after approval). Only rows backed by a file are shown.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskWorkspace } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { SectionHeader } from '../workspace/workspace-ui';

type Section = 'spec' | 'architecture' | 'security';

export interface SecuritySummary {
  blocking: number;
  ran: boolean;
  pentest?: 'clear' | 'findings' | 'skipped' | 'error' | 'cancelled';
}

/** Exported for tests. */
export function summarizeSecurity(workspace: TaskWorkspace): SecuritySummary | null {
  const { gates, pentest } = workspace.security;
  if (!gates && !pentest) return null;
  const blocking =
    (gates?.findings.length ?? 0) + (pentest?.status === 'findings' ? pentest.findings.filter((f) => f.blocking).length : 0);
  return { blocking, ran: (gates?.ran.length ?? 0) > 0 || !!pentest, pentest: pentest?.status };
}

function Row({
  label,
  value,
  attention,
  onOpen,
  openLabel,
}: {
  label: string;
  value: ReactNode;
  attention?: boolean;
  onOpen: () => void;
  openLabel: string;
}) {
  return (
    <li className="border-b border-border">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label}: ${openLabel}`}
        className="group flex min-h-11 w-full items-center gap-4 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
        <span className={cn('min-w-0 flex-1 text-sm', attention ? 'font-semibold text-destructive' : 'text-foreground')}>{value}</span>
        <span className="shrink-0 pr-2 text-xs font-medium text-foreground underline-offset-2 group-hover:underline">{openLabel}</span>
      </button>
    </li>
  );
}

export function WorkspaceChecks({
  workspace,
  loading,
  onOpen,
}: {
  workspace: TaskWorkspace | null;
  loading: boolean;
  onOpen: (section: Section) => void;
}) {
  const { t } = useTranslation('tasks');

  if (!workspace) {
    if (!loading) return null;
    return (
      <div role="status" aria-busy="true" className="flex items-center gap-3 border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
        <span aria-hidden="true" className="vt-breathe h-2 w-2 bg-foreground" />
        {t('workspace.loading')}
      </div>
    );
  }

  const criteria = workspace.spec?.criteria ?? [];
  const pass = criteria.filter((c) => c.status === 'pass').length;
  const fail = criteria.filter((c) => c.status === 'fail').length;
  const untested = criteria.length - pass - fail;
  const diagrams = workspace.architecture.diagrams.length;
  const adrs = workspace.architecture.adrs.length;
  const hasArchitecture = !!workspace.architecture.markdown || diagrams + adrs > 0;
  const security = summarizeSecurity(workspace);

  if (!workspace.spec && !hasArchitecture && !security) return null;

  const open = t('overview.checks.open');

  return (
    <section aria-labelledby="overview-checks">
      <SectionHeader id="overview-checks" title={t('overview.checks.title')} />
      <ul>
        {workspace.spec && (
          <Row
            label={t('overview.checks.criteria')}
            attention={fail > 0}
            onOpen={() => onOpen('spec')}
            openLabel={open}
            value={
              criteria.length === 0 ? (
                t('overview.checks.noCriteria')
              ) : workspace.hasQaCoverage ? (
                <span className="font-mono text-[13px] tabular-nums">{t('workspace.spec.criteriaSummary', { pass, fail, untested })}</span>
              ) : (
                <span>
                  <span className="font-mono text-[13px] tabular-nums">{t('overview.checks.criteriaCount', { count: criteria.length })}</span>
                  <span className="ml-2 text-muted-foreground">{t('overview.checks.noQaYet')}</span>
                </span>
              )
            }
          />
        )}
        {hasArchitecture && (
          <Row
            label={t('overview.checks.architecture')}
            onOpen={() => onOpen('architecture')}
            openLabel={open}
            value={<span className="font-mono text-[13px] tabular-nums">{t('overview.checks.architectureSummary', { diagrams, adrs })}</span>}
          />
        )}
        {security && (
          <Row
            label={t('overview.checks.security')}
            attention={security.blocking > 0}
            onOpen={() => onOpen('security')}
            openLabel={open}
            value={
              security.blocking > 0
                ? t('overview.checks.securityBlocking', { count: security.blocking })
                : security.pentest === 'clear'
                  ? t('overview.checks.securityClear')
                  : security.ran
                    ? t('overview.checks.securityGatesClear')
                    : t('overview.checks.securitySkipped')
            }
          />
        )}
      </ul>
    </section>
  );
}
