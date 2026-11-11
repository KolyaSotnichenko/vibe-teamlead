/**
 * A date in the UI language: day and month ("Sep 30", "30 вер."), with the year on request
 * ("Sep 30, 2026"). Empty for a date that cannot be read.
 */
export function formatDate(iso: string, language: string, { withYear = false }: { withYear?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(date);
}
