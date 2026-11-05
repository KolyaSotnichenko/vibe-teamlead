/**
 * Security section of the task workspace: the hard gates (gitleaks, OSV-Scanner, Semgrep)
 * that run before every QA review, and the Strix penetration test after approval.
 */

import { useTranslation } from 'react-i18next';
import type { TaskWorkspace, WorkspaceSecurityFinding } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { TOOL_NAMES, gateSkipFix, openToolsSettings, pentestSkipFix, type SkipFix } from '../../tools-check';
import { EmptyState, MonoTag, Notice, SectionHeader } from './workspace-ui';

/** One line under a "skipped" notice: the command that fixes it, and where to check again. */
function SkipFixHint({ fix }: { fix: SkipFix }) {
  const { t } = useTranslation(['settings']);
  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-foreground">
      <span>
        {fix.kind === 'start' ? t('settings:tools.securityHint.start') : t('settings:tools.securityHint.install', { tool: TOOL_NAMES[fix.tool] })}
      </span>
      <code className="select-all font-mono text-xs text-foreground">{fix.command}</code>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <button
        type="button"
        onClick={openToolsSettings}
        className="text-sm font-medium text-foreground underline underline-offset-4 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {t('settings:tools.securityHint.openSettings')}
      </button>
    </p>
  );
}

function FindingRow({ finding }: { finding: WorkspaceSecurityFinding }) {
  const { t } = useTranslation(['tasks']);
  return (
    <li className={cn('border-b border-border px-4 py-3 last:border-b-0', finding.blocking && 'border-l-2 border-l-destructive')}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <MonoTag>{finding.source}</MonoTag>
        {finding.severity && (
          <span
            className={cn(
              'font-mono text-[11px] font-semibold uppercase tracking-[0.04em]',
              finding.blocking ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {finding.severity}
          </span>
        )}
        <span className="text-sm font-medium text-foreground">{finding.title}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {finding.blocking ? t('tasks:workspace.security.blocking') : t('tasks:workspace.security.belowThreshold')}
        </span>
      </div>
      {finding.location && <p className="mt-1 font-mono text-xs text-muted-foreground">{finding.location}</p>}
      {finding.detail && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{finding.detail}</p>}
    </li>
  );
}

function StatusChip({ status, blocked }: { status: string; blocked: boolean }) {
  const { t } = useTranslation(['tasks']);
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.04em]',
        blocked ? 'bg-destructive text-destructive-foreground' : 'border border-foreground text-foreground'
      )}
    >
      {t(`tasks:workspace.security.status.${status}`)}
    </span>
  );
}

export function SecurityTab({ workspace }: { workspace: TaskWorkspace }) {
  const { t } = useTranslation(['tasks']);
  const { gates, pentest } = workspace.security;

  if (!gates && !pentest) {
    return <EmptyState title={t('tasks:workspace.security.emptyTitle')} body={t('tasks:workspace.security.emptyBody')} />;
  }

  const gatesBlocked = (gates?.findings.length ?? 0) > 0;
  const pentestBlocked = pentest?.status === 'findings' && pentest.findings.some((f) => f.blocking);
  const pentestFix = pentest?.status === 'skipped' ? pentestSkipFix(pentest.reason) : null;

  return (
    <div className="space-y-8">
      <section aria-labelledby="ws-gates" className="space-y-3">
        <SectionHeader
          id="ws-gates"
          title={t('tasks:workspace.security.gatesTitle')}
          meta={t('tasks:workspace.security.gatesMeta')}
          action={gates ? <StatusChip status={gatesBlocked ? 'findings' : 'clear'} blocked={gatesBlocked} /> : undefined}
        />
        {!gates ? (
          <Notice>{t('tasks:workspace.security.noGates')}</Notice>
        ) : (
          <>
            {gatesBlocked ? (
              <ul className="border border-foreground">
                {gates.findings.map((f, i) => (
                  <FindingRow key={`${f.title}-${i}`} finding={f} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('tasks:workspace.security.gatesClear')}</p>
            )}
            {gatesBlocked && <p className="text-sm text-destructive">{t('tasks:workspace.security.gatesBlocked', { count: gates.findings.length })}</p>}
            {gates.skipped.map((s) => {
              const fix = gateSkipFix(s.gate, s.reason);
              return (
                <Notice key={s.gate}>
                  {t('tasks:workspace.security.skipped', { gate: s.gate, reason: s.reason })}
                  {fix && <SkipFixHint fix={fix} />}
                </Notice>
              );
            })}
          </>
        )}
      </section>

      <section aria-labelledby="ws-pentest" className="space-y-3">
        <SectionHeader
          id="ws-pentest"
          title={t('tasks:workspace.security.pentestTitle')}
          meta={
            pentest?.scanMode
              ? [
                  t('tasks:workspace.security.pentestMeta', { mode: pentest.scanMode, failOn: pentest.failOn ?? 'high' }),
                  pentest.costUsd !== undefined ? t('tasks:workspace.security.cost', { cost: pentest.costUsd.toFixed(2) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
          action={pentest ? <StatusChip status={pentest.status} blocked={pentestBlocked} /> : undefined}
        />
        {!pentest ? (
          <Notice>{t('tasks:workspace.security.noPentest')}</Notice>
        ) : (
          <>
            {pentest.reason && (
              <Notice>
                {pentest.reason}
                {pentestFix && <SkipFixHint fix={pentestFix} />}
              </Notice>
            )}
            {pentest.findings.length > 0 ? (
              <ul className="border border-foreground">
                {pentest.findings.map((f, i) => (
                  <FindingRow key={`${f.title}-${i}`} finding={f} />
                ))}
              </ul>
            ) : (
              pentest.status === 'clear' && <p className="text-sm text-muted-foreground">{t('tasks:workspace.security.pentestClear')}</p>
            )}
            {pentest.reportPath && (
              <p className="text-sm text-muted-foreground">
                {t('tasks:workspace.security.report')}: <span className="font-mono text-xs text-foreground">{pentest.reportPath}</span>
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
