/**
 * Setup → path C, a ready package from a designer: choose a .zip or a folder, see what it holds
 * (components, logos, fonts, colours, the licence line, what it replaces, skipped files), choose
 * the themes, import. Package-derived text is shown as plain text, never as HTML.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Notice } from '../task-detail/workspace/workspace-ui';
import type { DesignPackageSummary, DesignSystemInfo, DesignThemes } from '../../../shared/types';

type Stage = 'choose' | 'reading' | 'summary' | 'importing';

/** Colours a package keeps, light and dark together (PACKAGE_MAX_COLORS in main) */
const MAX_COLORS = 400;

/** Progress lines kept on screen while importing */
const MAX_LINES = 8;

/** Light only, or light and dark with a switch */
export function ThemesChoice({
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  value: DesignThemes;
  onChange: (themes: DesignThemes) => void;
  disabled?: boolean;
  /** id of the heading that names the group */
  labelledBy: string;
}) {
  const { t } = useTranslation('common');
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex max-w-3xl flex-col border-t border-border">
      {(['light', 'light-dark'] as const).map((themes) => {
        const key = themes === 'light' ? 'light' : 'lightDark';
        return (
          <label key={themes} className="flex cursor-pointer items-start gap-3 border-b border-border py-2.5">
            <input
              type="radio"
              name={`${id}-themes`}
              checked={value === themes}
              disabled={disabled}
              onChange={() => onChange(themes)}
              aria-labelledby={`${id}-${key}`}
              aria-describedby={`${id}-${key}-hint`}
              className="mt-1 h-4 w-4"
            />
            <span className="flex flex-col">
              <span id={`${id}-${key}`} className="text-sm font-medium text-foreground">{t(`context.design.package.themes.${key}`)}</span>
              <span id={`${id}-${key}-hint`} className="text-xs text-muted-foreground">{t(`context.design.package.themes.${key}Hint`)}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

interface PanelProps {
  projectId: string;
  /** Another design job is running */
  disabled?: boolean;
  onImported: (info: DesignSystemInfo) => void;
  /** A message for the tab's error line; null clears it */
  onError: (message: string | null) => void;
  /** True while a package imports; the tab locks its paths and parts and shows progress with Cancel */
  onBusy?: (busy: boolean) => void;
}

/** One panel per project: a summary never follows it to another project */
export function DesignPackagePanel(props: PanelProps) {
  return <PackagePanel key={props.projectId} {...props} />;
}

function PackagePanel({ projectId, disabled, onImported, onError, onBusy }: PanelProps) {
  const { t } = useTranslation('common');
  const design = window.electronAPI.design;
  const [stage, setStage] = useState<Stage>('choose');
  const [summary, setSummary] = useState<DesignPackageSummary | null>(null);
  const [themes, setThemes] = useState<DesignThemes>('light');
  const headingId = useId();
  const [lines, setLines] = useState<Array<{ id: number; text: string }>>([]);
  const lineId = useRef(0);

  // An inspected package left behind (path closed, project switched) is dropped; one still
  // being read when the panel goes away is dropped once the read ends
  const pending = useRef(false);
  pending.current = stage === 'summary';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) void window.electronAPI.design.cancelPackage(projectId);
    };
  }, [projectId]);

  useEffect(() => {
    if (stage !== 'importing') return;
    return design.onProgress((event) => {
      if (event.projectId === projectId) setLines((prev) => [...prev, { id: lineId.current++, text: event.message }].slice(-MAX_LINES));
    });
  }, [design, projectId, stage]);

  const busy = (on: boolean) => onBusy?.(on);

  const choose = async () => {
    onError(null);
    try {
      const picked = await design.pickPackage();
      if (!picked.success) {
        if (picked.error) onError(picked.error);
        return;
      }
      if (!picked.data) return;
      setStage('reading');
      const result = await design.inspectPackage(projectId, picked.data);
      if (!mounted.current) {
        if (result.success) void design.cancelPackage(projectId);
        return;
      }
      if (result.success && result.data) {
        setSummary(result.data);
        setThemes('light');
        setStage('summary');
      } else {
        if (result.error) onError(result.error);
        setStage('choose');
      }
    } catch (e) {
      if (!mounted.current) return;
      onError(e instanceof Error ? e.message : String(e));
      setStage('choose');
    }
  };

  const drop = () => {
    onError(null);
    setSummary(null);
    setStage('choose');
    void design.cancelPackage(projectId);
  };

  const runImport = async () => {
    onError(null);
    setLines([]);
    setStage('importing');
    busy(true);
    try {
      const result = await design.importPackage(projectId, { themes: summary && summary.colors.dark > 0 ? themes : 'light' });
      if (result.success && result.data) {
        setSummary(null);
        setStage('choose');
        onImported(result.data);
        return;
      }
      // A failed or cancelled import puts the package back where it was: it can be imported again
      if (result.error && result.error !== 'Cancelled') onError(result.error);
      setStage('summary');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setStage('summary');
    } finally {
      busy(false);
    }
  };

  if (stage === 'choose' || stage === 'reading') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={disabled || stage === 'reading'} onClick={() => void choose()}>
          {stage === 'reading' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-2 h-4 w-4" />}
          {stage === 'reading' ? t('context.design.package.reading') : t('context.design.package.choose')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('context.design.package.chooseHint')}</span>
      </div>
    );
  }

  if (stage === 'importing') {
    return (
      // The tab's progress line carries the latest step and Cancel; this keeps the steps so far
      <div className="space-y-2 border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
        <p className="truncate text-foreground">{t('context.design.package.importing', { name: summary?.name ?? '' })}</p>
        {lines.length > 0 && (
          <ol className="space-y-0.5 pl-4 font-mono text-xs">
            {lines.map((line, i) => (
              <li key={line.id} className={i === lines.length - 1 ? 'text-foreground' : undefined}>
                {line.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  if (!summary) return null;
  const skippedCount = summary.skipped.length + (summary.skippedMore ?? 0);
  const count = (label: string, n: number) => (
    <li className="flex items-baseline gap-2 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-foreground">{t(`context.design.package.${label}`, { count: n })}</span>
    </li>
  );

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h5 className="text-lg font-semibold text-foreground">{summary.name}</h5>
        {summary.components.length > 0 && (
          <p className="font-mono text-xs text-muted-foreground">{summary.components.join(' · ')}</p>
        )}
      </div>

      <ul className="max-w-md" aria-label={t('context.design.package.holds')}>
        {count('components', summary.components.length)}
        {count('logos', summary.logos)}
        {count('fonts', summary.fonts)}
        {summary.hasTokens && count('colorsLight', summary.colors.light)}
        {summary.hasTokens && summary.colors.dark > 0 && count('colorsDark', summary.colors.dark)}
        {summary.references.added > 0 && count('references', summary.references.added)}
      </ul>

      {summary.references.skipped > 0 && (
        <Notice>{t('context.design.package.referencesSkipped', { count: summary.references.skipped, max: summary.references.added })}</Notice>
      )}

      {!summary.hasTokens && <Notice>{t('context.design.package.noTokens')}</Notice>}

      {(summary.colorsDropped ?? 0) > 0 && (
        <Notice>{t('context.design.package.colorsDropped', { count: summary.colorsDropped, max: MAX_COLORS })}</Notice>
      )}

      {summary.licenceLine && (
        <figure className="max-w-prose space-y-1">
          <figcaption className="font-mono text-xs uppercase text-muted-foreground">{t('context.design.package.licence')}</figcaption>
          <blockquote className="border-l-2 border-foreground pl-3 text-sm text-foreground">{summary.licenceLine}</blockquote>
        </figure>
      )}

      {summary.replaces && (
        <p className="max-w-prose border border-l-[3px] border-foreground border-l-[var(--vt-signal)] px-3 py-2 text-sm text-foreground">
          {t('context.design.package.replaces', { path: summary.replaces })}
        </p>
      )}

      {skippedCount > 0 && (
        <details className="max-w-prose text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('context.design.package.skipped', { count: skippedCount })}</summary>
          <ul className="mt-2 space-y-1">
            {summary.skipped.map((s) => (
              <li key={s.path} className="flex items-baseline justify-between gap-4 border-b border-border pb-1">
                <code className="min-w-0 truncate font-mono text-xs text-foreground" title={s.path}>{s.path}</code>
                <span className="shrink-0 text-xs text-muted-foreground">{t(`context.design.package.skipReason.${s.reason}`)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {summary.colors.dark > 0 && (
        <div className="space-y-2">
          <p id={`${headingId}-themes`} className="text-sm font-medium text-foreground">{t('context.design.package.themes.title')}</p>
          <ThemesChoice value={themes} onChange={setThemes} labelledBy={`${headingId}-themes`} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled} onClick={() => void runImport()}>
          {t('context.design.package.import')}
        </Button>
        <Button variant="outline" onClick={drop}>
          {t('buttons.cancel')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('context.design.start.oneSession')}</span>
      </div>
    </div>
  );
}
