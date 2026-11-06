/**
 * What the app's own run of the project's checks found, as the task window shows it.
 * The file sits where agents can reach, so reading trusts nothing in it. It only says
 * what to display: no decision is taken from it. Pure.
 */

export type VerificationOutcome = 'passed' | 'failed' | 'timed_out' | 'unavailable';

export interface VerificationSummary {
  status: 'passed' | 'regression' | 'not_verified' | 'not_configured';
  commit?: string;
  checks: { command: string; outcome: VerificationOutcome; onBase?: VerificationOutcome }[];
  services?: { status: 'started' | 'unavailable'; images: string[] };
  migrationsSkipped?: boolean;
}

const STATUSES = ['passed', 'regression', 'not_verified', 'not_configured'];
const OUTCOMES = ['passed', 'failed', 'timed_out', 'unavailable'];

export function parseVerificationSummary(text: string): VerificationSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status) || !Array.isArray(raw.checks)) return null;

  const checks: VerificationSummary['checks'] = [];
  for (const entry of raw.checks) {
    const check = entry as Record<string, unknown> | null;
    if (typeof check?.command !== 'string' || typeof check.outcome !== 'string' || !OUTCOMES.includes(check.outcome)) continue;
    const onBase = typeof check.onBase === 'string' && OUTCOMES.includes(check.onBase) ? (check.onBase as VerificationOutcome) : undefined;
    checks.push({ command: check.command, outcome: check.outcome as VerificationOutcome, ...(onBase ? { onBase } : {}) });
  }

  const services = raw.services as { status?: unknown; images?: unknown } | undefined;
  const validServices = (services?.status === 'started' || services?.status === 'unavailable') && Array.isArray(services.images);
  return {
    status: raw.status as VerificationSummary['status'],
    ...(typeof raw.commit === 'string' ? { commit: raw.commit } : {}),
    checks,
    ...(validServices ? { services: { status: services.status as 'started' | 'unavailable', images: (services.images as unknown[]).filter((image): image is string => typeof image === 'string') } } : {}),
    ...(raw.migrationsSkipped === true ? { migrationsSkipped: true } : {}),
  };
}
