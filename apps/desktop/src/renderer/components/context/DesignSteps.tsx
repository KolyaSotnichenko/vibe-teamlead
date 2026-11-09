/**
 * The Design system tab's three steps: references (optional) → the design system → applying
 * it to the code. The step to do next is the dark cell; the rest say where they stand.
 */

import { useTranslation } from 'react-i18next';

import type { DesignSystemMeta } from '../../../shared/types';
import { cn } from '../../lib/utils';
import type { DesignFlow, DesignStep } from './design-flow';

interface Cell {
  step: DesignStep;
  kicker: string;
  title: string;
  body: string;
  status: string;
  /** The status is a signal (vermilion), not a plain state */
  signal?: boolean;
}

export function DesignSteps({ flow, meta }: { flow: DesignFlow; meta?: DesignSystemMeta }) {
  const { t, i18n } = useTranslation('common');
  const k = (key: string, o?: Record<string, unknown>): string => String(o ? t(`context.design.flow.${key}`, o) : t(`context.design.flow.${key}`));
  const exists = flow.system.status !== 'none';

  const refs = flow.references;
  const references: Cell = {
    step: 'references',
    kicker: k(exists ? 'kicker.references' : 'kicker.optional'),
    title: k('references.title'),
    body: refs.count === 0 ? k('references.empty') : refs.fresh ? k('references.fresh', { count: refs.count, fresh: refs.fresh }) : exists ? k('references.held', { count: refs.count }) : k('references.added', { count: refs.count }),
    status: refs.count === 0 ? k('references.statusNone') : refs.fresh ? k('references.statusChanged') : k('references.statusDone'),
    signal: refs.fresh > 0,
  };

  const date = meta ? new Date(meta.writtenAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' }) : '';
  const made = !meta ? k('system.exists') : meta.how === 'direction' && meta.direction ? k('system.direction', { name: meta.direction, date }) : k(`system.${meta.how === 'direction' ? 'edited' : meta.how}`, { date });
  const system: Cell = {
    step: 'system',
    kicker: flow.current === 'system' ? (exists ? k('kicker.next', { n: 2 }) : k('kicker.startHere')) : k('kicker.system'),
    title: k('system.title'),
    body: !exists ? k('system.none') : flow.system.status === 'stale' ? `${made}. ${k('system.staleNote')}` : made,
    status: k(`system.${flow.system.status === 'none' ? 'statusNone' : flow.system.status === 'stale' ? 'statusStale' : 'statusDone'}`),
  };

  const a = flow.apply;
  const apply: Cell = {
    step: 'apply',
    kicker: flow.current === 'apply' ? k('kicker.next', { n: 3 }) : a.status === 'waiting' ? k('kicker.afterCode') : k('kicker.apply'),
    title: k('apply.title'),
    body: k(`apply.${a.status}`),
    status:
      a.status === 'diff'
        ? `${k('apply.places', { count: a.findings })} ${k('apply.inFiles', { count: a.files })}`
        : a.status === 'clean'
          ? `${k('apply.uiFiles', { count: a.uiFiles })} · ${k('apply.noDiff')}`
          : k(`apply.status${a.status[0].toUpperCase()}${a.status.slice(1)}`),
    signal: a.status === 'diff',
  };

  return (
    <ol aria-label={k('label')} className="grid grid-cols-1 border border-foreground md:grid-cols-3">
      {[references, system, apply].map((cell, i) => {
        const current = flow.current === cell.step;
        return (
          <li
            key={cell.step}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex flex-col gap-1.5 px-5 py-4',
              i > 0 && 'border-t border-border md:border-l md:border-t-0',
              current ? 'bg-foreground text-background' : 'text-foreground',
            )}
          >
            <span className={cn('flex items-center gap-2 font-mono text-xs', current ? 'text-background/80' : 'text-muted-foreground')}>
              {/* The step to do next: a vermilion mark (graphic, reads on ink and on paper) */}
              {current && <span aria-hidden className="h-2 w-2 shrink-0 bg-[var(--vt-signal)]" />}
              {cell.kicker}
            </span>
            <span className="text-base font-semibold">{cell.title}</span>
            <span className={cn('text-sm', current ? 'text-background/80' : 'text-muted-foreground')}>{cell.body}</span>
            <span
              className={cn(
                'mt-1 font-mono text-xs',
                cell.signal && !current ? 'text-destructive' : current ? 'text-background/70' : 'text-muted-foreground',
              )}
            >
              {cell.status}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
