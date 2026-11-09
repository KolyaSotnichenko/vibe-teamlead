/**
 * Context → Design system, in two parts:
 * - Setup: pick a path — A, keep the current look (extract it from the code, with brand rules
 *   if you have them) or B, a new look (references, then a brief and three directions) — or a
 *   file already in the repository; then apply the system to the code, how QA checks it and
 *   Storybook. References live inside the path that uses them.
 * - View: the system itself (colours, fonts, rules, the document), editable.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ExternalLink, Loader2, Pencil, Play, RefreshCw, ScanSearch, Sparkles, Square } from 'lucide-react';
import { Button } from '../ui/button';
import { ApplyDesignSystem } from './ApplyDesignSystem';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { EmptyState, Notice, SectionHeader, WorkspaceMarkdown } from '../task-detail/workspace/workspace-ui';
import { loadProjects } from '../../stores/project-store';
import { DesignReferences } from './DesignReferences';
import { designFlow } from './design-flow';
import type { DesignAudit, DesignBrief, DesignDirection, DesignQaMode, DesignReferenceList, DesignSystemInfo, DesignTokens } from '../../../shared/types';

type Busy = 'extract' | 'propose' | 'write' | 'save' | 'storybook' | null;
type Part = 'setup' | 'view';
type Path = 'keep' | 'new';

function Swatch({ name, value, role }: { name: string; value: string; role?: string }) {
  return (
    <div className="flex min-w-0 items-stretch border border-border">
      <span className="w-12 shrink-0 border-r border-border" style={{ backgroundColor: value }} aria-hidden="true" />
      <div className="min-w-0 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="font-mono text-xs text-muted-foreground">{value.toUpperCase()}</span>
        </div>
        {role && <p className="truncate text-xs text-muted-foreground" title={role}>{role}</p>}
      </div>
    </div>
  );
}

function TokensView({ tokens }: { tokens: DesignTokens }) {
  const { t } = useTranslation('common');
  const rule = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm text-foreground">{value}</span>
    </div>
  );
  return (
    <div className="space-y-6">
      {tokens.colors.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {tokens.colors.map((c) => (
            <Swatch key={`${c.name}${c.value}`} {...c} />
          ))}
        </div>
      )}
      {tokens.fonts.length > 0 && (
        <div className="space-y-2">
          {tokens.fonts.map((f) => (
            <div key={`${f.role}${f.family}`} className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
              <span className="truncate text-xl text-foreground" style={{ fontFamily: `'${f.family}', system-ui, sans-serif` }}>
                {f.family}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{f.role}</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t('context.design.fontsNote')}</p>
        </div>
      )}
      <div className="max-w-md">
        {rule(t('context.design.radius'), tokens.radius.length ? tokens.radius.map((r) => `${r}px`).join(', ') : '—')}
        {rule(t('context.design.shadows'), tokens.shadows ? t('context.design.allowed') : t('context.design.none'))}
        {rule(t('context.design.gradients'), tokens.gradients ? t('context.design.allowed') : t('context.design.none'))}
        {tokens.spacing?.length ? rule(t('context.design.spacing'), tokens.spacing.join(' · ')) : null}
      </div>
      {tokens.bannedPatterns?.length ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t('context.design.banned')}</p>
          <ul className="space-y-1">
            {tokens.bannedPatterns.map((b) => (
              <li key={b.pattern} className="flex items-baseline gap-3 text-sm">
                <code className="shrink-0 font-mono text-xs text-foreground">{b.pattern}</code>
                <span className="text-muted-foreground">{b.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DirectionCard({ direction, onUse, disabled }: { direction: DesignDirection; onUse: () => void; disabled: boolean }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col border border-foreground bg-card">
      <div className="flex h-16" aria-hidden="true">
        {direction.palette.map((c) => (
          <span key={c.value + c.name} className="flex-1" style={{ backgroundColor: c.value }} title={`${c.name} ${c.value}`} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h4 className="text-base font-semibold text-foreground">{direction.name}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{direction.summary}</p>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{direction.fonts.map((f) => `${f.family} (${f.role})`).join(' · ')}</p>
        <ul className="space-y-1 text-sm text-foreground">
          {direction.principles.map((p) => (
            <li key={p} className="border-l-2 border-border pl-2">{p}</li>
          ))}
        </ul>
        <Button className="mt-auto" onClick={onUse} disabled={disabled}>
          {t('context.design.useDirection')}
        </Button>
      </div>
    </div>
  );
}

/** One numbered step inside a path */
function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <span className="flex h-7 w-7 items-center justify-center border border-foreground font-mono text-xs text-foreground">{n}</span>
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <h4 className="text-base font-semibold text-foreground">{title}</h4>
          {hint && <p className="max-w-prose text-sm text-muted-foreground">{hint}</p>}
        </div>
        {children}
      </div>
    </li>
  );
}

function PathCard({ label, title, body, selected, current, onSelect }: { label: string; title: string; body: string; selected: boolean; current: boolean; onSelect: () => void }) {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-11 flex-col items-start gap-2 border border-foreground p-5 text-left',
        selected ? 'bg-foreground text-background' : 'bg-card text-foreground hover:bg-accent',
      )}
    >
      <span className={cn('flex items-center gap-3 font-mono text-xs uppercase', selected ? 'text-background/70' : 'text-muted-foreground')}>
        {label}
        {current && (
          <span className={cn('inline-flex items-center gap-1 normal-case', selected ? 'text-background' : 'text-foreground')}>
            <Check className="h-3 w-3" aria-hidden />
            {t('context.design.setup.current')}
          </span>
        )}
      </span>
      <span className="text-lg font-semibold">{title}</span>
      <span className={cn('text-sm', selected ? 'text-background/80' : 'text-muted-foreground')}>{body}</span>
    </button>
  );
}

export function DesignSystemTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation('common');
  const [info, setInfo] = useState<DesignSystemInfo | null>(null);
  const [part, setPart] = useState<Part | null>(null);
  const [path, setPath] = useState<Path | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<DesignBrief>({ product: '', audience: '', mood: '' });
  const [directions, setDirections] = useState<DesignDirection[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftMarkdown, setDraftMarkdown] = useState('');
  const [draftTokens, setDraftTokens] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [showRepo, setShowRepo] = useState(false);
  const [storybookUrl, setStorybookUrl] = useState<string | null>(null);
  // Extracting again replaces the current document and tokens: ask first
  const [confirmExtract, setConfirmExtract] = useState(false);
  // The references (read by DesignReferences) and the whole-UI design check
  const [refList, setRefList] = useState<DesignReferenceList | null>(null);
  const [audit, setAudit] = useState<DesignAudit | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.design.get(projectId);
    if (result.success && result.data) {
      setInfo(result.data);
      setStorybookUrl(result.data.storybook.running?.url ?? null);
    } else if (result.error) setError(result.error);
  }, [projectId]);

  useEffect(() => {
    setInfo(null);
    setPart(null);
    setPath(null);
    setDirections(null);
    void refresh();
  }, [refresh]);

  // Check the code again whenever the system's tokens change (no model: git ls-files + a lint)
  const tokensKey = info?.exists ? JSON.stringify(info.tokens ?? null) : null;
  useEffect(() => {
    setAudit(undefined);
    if (tokensKey === null || !window.electronAPI.design.audit) return;
    let live = true;
    void window.electronAPI.design
      .audit(projectId)
      .then((result) => live && setAudit(result.success ? (result.data ?? null) : null))
      .catch(() => live && setAudit(null));
    return () => {
      live = false;
    };
  }, [projectId, tokensKey]);

  // The references, for the update banner and the new / in-the-system marks, even with no path open
  useEffect(() => {
    const design = window.electronAPI.design;
    if (!design.listReferences) return;
    let live = true;
    const load = () => void design.listReferences(projectId).then((r) => live && r.success && r.data && setRefList(r.data)).catch(() => {});
    load();
    const off = design.onReferencesChanged?.((id) => id === projectId && load());
    return () => {
      live = false;
      off?.();
    };
  }, [projectId]);

  useEffect(
    () => window.electronAPI.design.onProgress((event) => event.projectId === projectId && setProgress(event.message)),
    [projectId],
  );

  const run = async <T,>(kind: Busy, job: () => Promise<{ success: boolean; data?: T; error?: string }>, done: (data: T) => void) => {
    setBusy(kind);
    setError(null);
    setProgress(null);
    try {
      const result = await job();
      if (result.success && result.data !== undefined) done(result.data);
      else if (result.error && result.error !== 'Cancelled') setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const updateSettings = async (settings: Parameters<typeof window.electronAPI.updateProjectSettings>[1]) => {
    await window.electronAPI.updateProjectSettings(projectId, settings);
    await loadProjects();
    await refresh();
  };

  const cancel = () => void window.electronAPI.design.cancel(projectId);

  // A new system is done: show it
  const written = (data: DesignSystemInfo) => {
    setInfo(data);
    setDirections(null);
    setPath(null);
    setPart('view');
  };
  const extract = () => void run('extract', () => window.electronAPI.design.extract(projectId), written);
  const propose = () => void run('propose', () => window.electronAPI.design.propose(projectId, brief), setDirections);

  const startEdit = () => {
    if (!info) return;
    setDraftMarkdown(info.markdown ?? '');
    setDraftTokens(info.tokens ? JSON.stringify(info.tokens, null, 2) : '');
    setEditing(true);
  };

  const saveEdit = () => {
    let tokens: DesignTokens | undefined;
    if (draftTokens.trim()) {
      try {
        tokens = JSON.parse(draftTokens) as DesignTokens;
      } catch {
        setError(t('context.design.tokensInvalid'));
        return;
      }
    }
    void run('save', () => window.electronAPI.design.save(projectId, { markdown: draftMarkdown, tokens }), (data) => {
      setInfo(data);
      setEditing(false);
    });
  };

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const working = busy !== null;
  const flow = designFlow({ exists: info.exists, meta: info.meta, references: refList?.references ?? [], audit });
  const stale = flow.system.status === 'stale';
  // Setup first while there is nothing to view or the system needs an update
  const shown: Part = part ?? (!info.exists || stale ? 'setup' : 'view');
  const meta = info.meta;
  const currentPath: Path | null = !info.exists || !meta ? null : meta.how === 'extract' ? 'keep' : meta.how === 'direction' ? 'new' : null;
  const fresh = meta ? flow.freshIds : null;
  const qaModes: DesignQaMode[] = ['block', 'warn', 'off'];

  const date = meta ? new Date(meta.writtenAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' }) : '';
  const made = !meta
    ? t('context.design.status.exists')
    : meta.how === 'direction' && meta.direction
      ? t('context.design.status.direction', { name: meta.direction, date })
      : t(`context.design.status.${meta.how === 'direction' ? 'edited' : meta.how}`, { date });
  const code = audit ? (audit.findings > 0 ? `${t('context.design.status.places', { count: audit.findings })} ${t('context.design.status.inFiles', { count: audit.files })}` : t('context.design.status.clean')) : null;
  const status = !info.exists ? t('context.design.status.none') : [made, code].filter(Boolean).join(' · ');

  const progressLine = working && (busy === 'extract' || busy === 'propose' || busy === 'write') && (
    <div role="status" aria-busy="true" className="flex items-center justify-between gap-4 border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-2 w-2 shrink-0 animate-pulse bg-foreground" aria-hidden="true" />
        <span className="truncate">{progress ?? t(`context.design.working.${busy}`)}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={cancel}>
        {t('buttons.cancel')}
      </Button>
    </div>
  );

  // ----- Path A: keep the current look -----
  const keepPanel = (
    <ol className="space-y-5 border border-foreground bg-card p-5" aria-label={t('context.design.start.keepTitle')}>
      <Step n={1} title={t('context.design.setup.keep.rulesTitle')} hint={t('context.design.setup.keep.rulesHint')}>
        <DesignReferences projectId={projectId} onList={setRefList} bare defaultRole="as-is" fresh={fresh} />
      </Step>
      <Step n={2} title={t('context.design.setup.keep.extractTitle')} hint={t('context.design.setup.keep.extractHint')}>
        {confirmExtract ? (
          <div role="alertdialog" aria-labelledby="ds-replace" className="flex flex-wrap items-center justify-between gap-3 border border-foreground px-4 py-3">
            <p id="ds-replace" className="max-w-prose text-sm text-foreground">
              {info.source === 'repo' ? t('context.design.replaceRepo', { path: info.markdownPath }) : t('context.design.replaceApp')}
            </p>
            <div className="flex gap-2">
              {/* Focus starts on Cancel (design system: confirmation dialogs) */}
              <Button variant="outline" size="sm" autoFocus onClick={() => setConfirmExtract(false)}>
                {t('buttons.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setConfirmExtract(false);
                  extract();
                }}
              >
                {t('context.design.replace')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={working} onClick={() => (info.exists ? setConfirmExtract(true) : extract())}>
              <ScanSearch className="mr-2 h-4 w-4" />
              {info.exists ? t('context.design.extractAgain') : t('context.design.start.extract')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('context.design.start.oneSession')}</span>
          </div>
        )}
      </Step>
    </ol>
  );

  // ----- Path B: a new look -----
  const newPanel = (
    <ol className="space-y-5 border border-foreground bg-card p-5" aria-label={t('context.design.start.newTitle')}>
      <Step n={1} title={t('context.design.setup.new.refsTitle')} hint={t('context.design.setup.new.refsHint')}>
        <DesignReferences projectId={projectId} onList={setRefList} bare fresh={fresh} />
      </Step>
      <Step n={2} title={t('context.design.setup.new.briefTitle')} hint={t('context.design.setup.new.briefHint')}>
        {!directions ? (
          <div className="max-w-2xl space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ds-product">{t('context.design.brief.product')}</Label>
              <Textarea id="ds-product" rows={3} value={brief.product} placeholder={t('context.design.brief.productPlaceholder')} onChange={(e) => setBrief({ ...brief, product: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-audience">{t('context.design.brief.audience')}</Label>
              <Input id="ds-audience" value={brief.audience} placeholder={t('context.design.brief.audiencePlaceholder')} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-mood">{t('context.design.brief.mood')}</Label>
              <Input id="ds-mood" value={brief.mood} placeholder={t('context.design.brief.moodPlaceholder')} onChange={(e) => setBrief({ ...brief, mood: e.target.value })} />
            </div>
            <Button disabled={!brief.product.trim() || working} onClick={propose}>
              <Sparkles className="mr-2 h-4 w-4" />
              {t('context.design.propose')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('context.design.chooseDirection')}</p>
            {info.exists && <Notice>{t('context.design.setup.new.replaces')}</Notice>}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {directions.map((d) => (
                <DirectionCard key={d.id} direction={d} disabled={working} onUse={() => void run('write', () => window.electronAPI.design.write(projectId, brief, d), written)} />
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={working} onClick={propose}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('context.design.otherDirections')}
              </Button>
              <Button variant="ghost" disabled={working} onClick={() => setDirections(null)}>
                {t('context.design.editBrief')}
              </Button>
            </div>
          </div>
        )}
      </Step>
    </ol>
  );

  const setupPart = (
    <div className="space-y-10">
      {stale && (
        <section aria-labelledby="ds-stale" className="flex flex-col gap-4 border border-l-[3px] border-foreground border-l-[var(--vt-signal)] bg-card px-5 py-4 md:flex-row md:items-center md:gap-8">
          <div className="flex-1 space-y-1.5">
            <h3 id="ds-stale" className="text-base font-semibold text-foreground">{t('context.design.stale.title', { count: flow.references.fresh })}</h3>
            <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.stale.body')}</p>
          </div>
          <div className="flex flex-col gap-2 md:min-w-[260px]">
            <Button disabled={working} onClick={() => setPath('new')}>
              {t('context.design.stale.newDirection')}
            </Button>
            <Button variant="outline" disabled={working} onClick={() => setPath('keep')}>
              {t('context.design.stale.refresh')}
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-4" aria-labelledby="ds-start">
        <SectionHeader id="ds-start" title={info.exists ? t('context.design.setup.changeTitle') : t('context.design.start.title')} />
        <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.start.body')}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PathCard label={t('context.design.start.pathA')} title={t('context.design.start.keepTitle')} body={t('context.design.setup.keep.card')} selected={path === 'keep'} current={currentPath === 'keep'} onSelect={() => setPath(path === 'keep' ? null : 'keep')} />
          <PathCard label={t('context.design.start.pathB')} title={t('context.design.start.newTitle')} body={t('context.design.setup.new.card')} selected={path === 'new'} current={currentPath === 'new'} onSelect={() => setPath(path === 'new' ? null : 'new')} />
        </div>
        {path === 'keep' && keepPanel}
        {path === 'new' && newPanel}
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('context.design.start.repoQuestion')}{' '}
            <button type="button" aria-expanded={showRepo} onClick={() => setShowRepo(!showRepo)} className="text-foreground underline underline-offset-4">
              {t('context.design.start.repoLink')}
            </button>
          </p>
          {showRepo && (
            <div className="flex max-w-xl gap-2">
              <Input aria-label={t('context.design.repoTitle')} value={repoPath} placeholder="design/DESIGN-SYSTEM.md" className="font-mono" onChange={(e) => setRepoPath(e.target.value)} />
              <Button variant="outline" disabled={!repoPath.trim() || working} onClick={() => void updateSettings({ designSystemPath: repoPath.trim() })}>
                {t('context.design.useFile')}
              </Button>
            </div>
          )}
        </div>
      </section>

      {info.exists && <ApplyDesignSystem projectId={projectId} audit={audit} />}

      {info.exists && (
        <section className="space-y-3" aria-labelledby="ds-qa">
          <SectionHeader id="ds-qa" title={t('context.design.qaTitle')} />
          <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.qaBody')}</p>
          <div role="radiogroup" aria-label={t('context.design.qaTitle')} className="flex max-w-xl gap-2">
            {qaModes.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={info.qaMode === mode}
                onClick={() => void updateSettings({ designQaMode: mode })}
                className={cn(
                  'flex min-h-11 flex-1 flex-col items-start border px-3 py-2 text-left',
                  info.qaMode === mode ? 'border-foreground bg-foreground text-background' : 'border-border text-foreground hover:bg-accent',
                )}
              >
                <span className="text-sm font-medium">{t(`context.design.qaModes.${mode}`)}</span>
                <span className={cn('text-xs', info.qaMode === mode ? 'text-background/80' : 'text-muted-foreground')}>{t(`context.design.qaModes.${mode}Hint`)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="ds-storybook">
        <SectionHeader
          id="ds-storybook"
          title="Storybook"
          meta={info.storybook.detected ? `${info.storybook.dir}${info.storybook.script ? ` · npm run ${info.storybook.script}` : ''}` : t('context.design.storybook.notSetUp')}
          action={
            info.storybook.detected ? (
              storybookUrl ? (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void window.electronAPI.openExternal(storybookUrl)}>
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    {t('context.design.storybook.openBrowser')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void window.electronAPI.design.stopStorybook(projectId).then(() => setStorybookUrl(null))}>
                    <Square className="mr-1.5 h-3.5 w-3.5" />
                    {t('context.design.storybook.stop')}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  disabled={busy === 'storybook'}
                  onClick={() =>
                    void run('storybook', () => window.electronAPI.design.startStorybook(projectId), (d) => {
                      setStorybookUrl(d.url);
                      // Storybook opens in the browser, not inside the app
                      void window.electronAPI.openExternal(d.url);
                    })
                  }
                >
                  {busy === 'storybook' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  {busy === 'storybook' ? t('context.design.storybook.starting') : t('context.design.storybook.start')}
                </Button>
              )
            ) : undefined
          }
        />
        <div className="flex max-w-2xl items-start justify-between gap-6">
          <div className="space-y-1">
            <Label htmlFor="ds-storybook-enabled" className="text-sm font-medium text-foreground">
              {t('context.design.storybook.enable')}
            </Label>
            <p className="text-sm text-muted-foreground">{t('context.design.storybook.enableBody')}</p>
          </div>
          <Switch id="ds-storybook-enabled" checked={info.storybook.enabled} onCheckedChange={(checked) => void updateSettings({ storybookEnabled: checked })} />
        </div>
        {storybookUrl && (
          <Notice>
            {t('context.design.storybook.runningAt')}{' '}
            <button type="button" onClick={() => void window.electronAPI.openExternal(storybookUrl)} className="font-mono text-foreground underline underline-offset-4">
              {storybookUrl}
            </button>
          </Notice>
        )}
        {!info.storybook.detected && info.storybook.enabled && <EmptyState compact title={t('context.design.storybook.pendingTitle')} body={t('context.design.storybook.pendingBody')} />}
      </section>
    </div>
  );

  const viewPart = !info.exists ? (
    <div className="space-y-4">
      <EmptyState title={t('context.design.view.emptyTitle')} body={t('context.design.view.emptyBody')} />
      <Button onClick={() => setPart('setup')}>{t('context.design.view.setUp')}</Button>
    </div>
  ) : (
    <div className="space-y-10">
      <section className="space-y-4" aria-labelledby="ds-overview">
        <SectionHeader id="ds-overview" title={t('context.design.view.tokens')} meta={`${info.markdownPath}${info.source === 'repo' ? ` · ${t('context.design.inRepo')}` : ''}`} />
        {info.tokensError && <Notice>{info.tokensError}</Notice>}
        {info.tokens ? <TokensView tokens={info.tokens} /> : <Notice>{t('context.design.noTokens')}</Notice>}
      </section>
      <section className="space-y-3" aria-labelledby="ds-doc">
        <SectionHeader
          id="ds-doc"
          title={t('context.design.document')}
          action={
            editing ? (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={working} onClick={() => setEditing(false)}>
                  {t('buttons.cancel')}
                </Button>
                <Button size="sm" disabled={working} onClick={saveEdit}>
                  {busy === 'save' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {t('buttons.save')}
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={startEdit}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                {t('context.design.edit')}
              </Button>
            )
          }
        />
        {editing ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ds-md">{info.markdownPath}</Label>
              <Textarea id="ds-md" rows={22} className="font-mono text-xs" value={draftMarkdown} onChange={(e) => setDraftMarkdown(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-tokens">{info.tokensPath ?? '.vibe-teamlead/design-tokens.json'}</Label>
              <Textarea id="ds-tokens" rows={14} className="font-mono text-xs" value={draftTokens} onChange={(e) => setDraftTokens(e.target.value)} />
            </div>
          </div>
        ) : (
          <WorkspaceMarkdown markdown={info.markdown ?? ''} />
        )}
      </section>
    </div>
  );

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-x-4 border-b border-foreground">
          <div role="tablist" aria-label={t('context.design.title')} className="flex">
            {(['setup', 'view'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={shown === p}
                onClick={() => setPart(p)}
                className={cn('-mb-px min-h-11 border-b-2 px-4 text-sm font-medium', shown === p ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {t(`context.design.tabs.${p}`)}
              </button>
            ))}
          </div>
          <p className="pb-2.5 font-mono text-xs text-muted-foreground">{status}</p>
        </div>

        {error && (
          <p role="alert" className="border-l-2 border-destructive bg-muted px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        )}
        {progressLine}

        <div role="tabpanel" aria-label={t(`context.design.tabs.${shown}`)}>
          {shown === 'setup' ? setupPart : viewPart}
        </div>
      </div>
    </ScrollArea>
  );
}
