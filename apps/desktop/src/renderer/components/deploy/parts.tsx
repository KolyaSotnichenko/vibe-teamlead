/** Small layout pieces shared by the Deploy tabs. */
import { cn } from '../../lib/utils';

export function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Notice({ tone, children }: { tone: 'attention' | 'info'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'border-l-2 bg-muted px-3 py-2 text-sm',
        tone === 'attention' ? 'border-destructive text-foreground' : 'border-foreground text-muted-foreground'
      )}
    >
      {children}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <dt className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm text-foreground">{children}</dd>
    </div>
  );
}
