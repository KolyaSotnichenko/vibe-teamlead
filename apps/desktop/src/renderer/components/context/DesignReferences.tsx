/**
 * Design system references: images, PDFs, token files and sites the design
 * system builds on. Each is digested once in the background (notes + measured
 * colours); the design agent works from the notes, so any number fits.
 */

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileCode, FileText, Globe, Image as ImageIcon, RotateCcw, Upload, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { cn } from '../../lib/utils';
import { Notice, SectionHeader } from '../task-detail/workspace/workspace-ui';
import type { DesignReference, DesignReferenceList, DesignReferenceRole } from '../../../shared/types';

type Row = DesignReferenceList['references'][number];

const KIND_ICON = { image: ImageIcon, pdf: FileText, tokens: FileCode, site: Globe } as const;

function Swatches({ colors, max = 6 }: { colors: string[]; max?: number }) {
  if (!colors.length) return null;
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {colors.slice(0, max).map((c, i) => (
        <span key={`${c}-${i}`} className="h-4 w-4 border border-border" style={{ background: c }} />
      ))}
    </span>
  );
}

function RoleSwitch({ role, onChange, label }: { role: DesignReferenceRole; onChange: (role: DesignReferenceRole) => void; label: string }) {
  const { t } = useTranslation('common');
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 border border-foreground text-xs">
      {(['as-is', 'inspiration'] as const).map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={role === r}
          onClick={() => onChange(r)}
          className={cn('min-h-8 px-2.5', role === r ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted')}
        >
          {t(`context.design.refs.roles.${r}`)}
        </button>
      ))}
    </div>
  );
}

function Status({ item: r, onRetry }: { item: DesignReference; onRetry: () => void }) {
  const { t } = useTranslation('common');
  if (r.status === 'ready') return null;
  if (r.status === 'error') {
    return (
      <span className="flex items-center gap-2 text-xs text-destructive">
        <span className="max-w-[260px] truncate" title={r.error}>{r.error ?? t('context.design.refs.failed')}</span>
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
          <RotateCcw className="h-3 w-3" aria-hidden />
          {t('context.design.refs.retry')}
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <span aria-hidden className="vt-breathe h-1.5 w-1.5 bg-foreground" />
      {t(r.status === 'digesting' ? 'context.design.refs.digesting' : 'context.design.refs.pending')}
    </span>
  );
}

function ReferenceRow({ row, onRole, onRemove, onRetry }: { row: Row; onRole: (r: DesignReferenceRole) => void; onRemove: () => void; onRetry: () => void }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[row.kind];
  const notes = row.notes;
  const palette = notes?.palette.map((c) => c.value) ?? [];
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex min-h-14 items-center gap-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={!notes}
          aria-expanded={open}
          aria-label={t('context.design.refs.details', { name: row.name })}
          className="flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden border border-border bg-muted">
          {row.thumbnail ? <img src={row.thumbnail} alt="" className="h-full w-full object-cover" /> : <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{row.name}</span>
          <span className="flex items-center gap-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {t(`context.design.refs.kinds.${row.kind}`)}
              {row.kind === 'site' ? ` · ${row.source}` : ''}
              {notes?.theme ? ` · ${t(`context.design.refs.theme.${notes.theme}`)}` : ''}
            </span>
            <Status item={row} onRetry={onRetry} />
          </span>
        </span>
        <Swatches colors={palette} />
        <RoleSwitch role={row.role} onChange={onRole} label={t('context.design.refs.roleLabel', { name: row.name })} />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('context.design.refs.remove', { name: row.name })}
          className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {open && notes && (
        <div className="mb-3 ml-9 space-y-2 border-l-2 border-foreground pl-3 text-sm">
          <p className="text-foreground">{notes.summary}</p>
          {notes.palette.length > 0 && (
            <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
              {notes.palette.map((c) => (
                <span key={c.value + (c.role ?? '')} className="flex items-center gap-1">
                  <span className="h-3 w-3 border border-border" style={{ background: c.value }} aria-hidden />
                  {c.value}
                  {c.role ? ` ${c.role}` : ''}
                  {c.share ? ` ${Math.round(c.share * 100)}%` : ''}
                </span>
              ))}
            </p>
          )}
          {notes.fonts.length > 0 && <p className="text-xs text-muted-foreground">{t('context.design.refs.fonts', { fonts: notes.fonts.join(', ') })}</p>}
          {[...notes.traits, ...notes.takeaways].length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {[...notes.traits, ...notes.takeaways].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function DesignReferences({ projectId }: { projectId: string }) {
  const { t } = useTranslation('common');
  const design = window.electronAPI.design;
  const [list, setList] = useState<DesignReferenceList | null>(null);
  const [urls, setUrls] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((result: { success: boolean; data?: DesignReferenceList; error?: string }) => {
    if (result.success && result.data) {
      setList(result.data);
      setError(null);
    } else if (!result.success) setError(result.error ?? t('context.design.refs.failed'));
  }, [t]);

  const load = useCallback(() => {
    void design?.listReferences?.(projectId).then(apply).catch(() => {});
  }, [design, projectId, apply]);

  useEffect(() => {
    load();
    return design?.onReferencesChanged?.((id) => id === projectId && load());
  }, [design, projectId, load]);

  if (!design?.listReferences) return null;

  const addFiles = async (paths: string[]) => {
    if (paths.length) apply(await design.addReferenceFiles(projectId, paths));
  };
  const pick = async () => {
    const result = await design.pickReferenceFiles();
    if (result.success && result.data) await addFiles(result.data);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles([...e.dataTransfer.files].map((f) => design.pathForFile(f)).filter(Boolean));
  };
  const addUrls = async () => {
    const lines = urls.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
    if (!lines.length) return;
    apply(await design.addReferenceUrls(projectId, lines));
    setUrls('');
  };

  const rows = list?.references ?? [];
  const summary = list?.summary;
  const asIs = rows.filter((r) => r.role === 'as-is');
  const inspiration = rows.filter((r) => r.role === 'inspiration');

  return (
    <section className="space-y-4" aria-labelledby="ds-refs">
      <SectionHeader
        id="ds-refs"
        title={t('context.design.refs.title')}
        meta={summary && summary.total > 0 ? t('context.design.refs.meta', { total: summary.total, ready: summary.ready }) : undefined}
      />
      <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.refs.body')}</p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn('flex flex-col items-center justify-center gap-2 border border-dashed px-4 py-5 text-center', dragging ? 'border-foreground bg-muted' : 'border-border')}
        >
          <Upload className="h-4 w-4 text-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">{t('context.design.refs.drop')}</p>
          <p className="font-mono text-[11px] text-muted-foreground">.png .jpg .webp .pdf · tokens .json .css tailwind.config</p>
          <Button variant="outline" size="sm" onClick={() => void pick()}>
            {t('context.design.refs.choose')}
          </Button>
        </div>
        <div className="flex flex-col gap-2 border border-border p-3">
          <label htmlFor="ds-ref-urls" className="text-sm font-medium text-foreground">{t('context.design.refs.sites')}</label>
          <Textarea
            id="ds-ref-urls"
            rows={3}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder={'linear.app\nhttps://stripe.com/docs'}
            className="font-mono text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t('context.design.refs.sitesHint')}</span>
            <Button size="sm" variant="outline" disabled={!urls.trim()} onClick={() => void addUrls()}>
              {t('context.design.refs.addSites')}
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="border-l-2 border-destructive bg-muted px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}

      {summary && summary.ready > 1 && (
        <div className="space-y-2">
          {(summary.sharedColors.length > 0 || summary.sharedFonts.length > 0) && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('context.design.refs.shared')}</span>
              <Swatches colors={summary.sharedColors} max={8} />
              {summary.sharedFonts.length > 0 && <span className="font-mono">{summary.sharedFonts.join(', ')}</span>}
            </p>
          )}
          {summary.conflicts.map((c) => (
            <Notice key={c.kind}>
              {c.kind === 'theme'
                ? t('context.design.refs.conflictTheme', { light: c.light, dark: c.dark })
                : t('context.design.refs.conflictFonts', { fonts: c.fonts.join(', ') })}
            </Notice>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-5">
          {[{ key: 'as-is', items: asIs }, { key: 'inspiration', items: inspiration }].map(({ key, items }) =>
            items.length ? (
              <div key={key}>
                <p className="mb-1 text-xs text-muted-foreground">{t(`context.design.refs.group.${key}`, { count: items.length })}</p>
                <ul className="border-t border-foreground">
                  {items.map((row) => (
                    <ReferenceRow
                      key={row.id}
                      row={row}
                      onRole={(role) => void design.setReferenceRole(projectId, row.id, role).then(apply)}
                      onRemove={() => void design.removeReference(projectId, row.id).then(apply)}
                      onRetry={() => void design.retryReference(projectId, row.id).then(apply)}
                    />
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {inspiration.length > 12 && <Notice>{t('context.design.refs.tooMany', { count: inspiration.length })}</Notice>}
        </div>
      )}
    </section>
  );
}
