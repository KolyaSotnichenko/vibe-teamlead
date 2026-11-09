/**
 * Context → Design system: the rules and tokens agents build UI by, how QA
 * checks them, and the project's Storybook.
 *
 * Empty: extract it from the code, design a new one from a brief (three
 * directions to choose from), or point at a file already in the repository.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, Pencil, Play, RefreshCw, ScanSearch, Sparkles, Square } from 'lucide-react';
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
import type { DesignBrief, DesignDirection, DesignQaMode, DesignSystemInfo, DesignTokens } from '../../../shared/types';

type Busy = 'extract' | 'propose' | 'write' | 'save' | 'storybook' | null;

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

export function DesignSystemTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation('common');
  const [info, setInfo] = useState<DesignSystemInfo | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [brief, setBrief] = useState<DesignBrief>({ product: '', audience: '', mood: '' });
  const [directions, setDirections] = useState<DesignDirection[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftMarkdown, setDraftMarkdown] = useState('');
  const [draftTokens, setDraftTokens] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [storybookUrl, setStorybookUrl] = useState<string | null>(null);
  // Extract again / new design replace the current document and tokens: ask first
  const [confirmReplace, setConfirmReplace] = useState<'extract' | 'generate' | null>(null);

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.design.get(projectId);
    if (result.success && result.data) {
      setInfo(result.data);
      setStorybookUrl(result.data.storybook.running?.url ?? null);
    } else if (result.error) setError(result.error);
  }, [projectId]);

  useEffect(() => {
    setInfo(null);
    setDirections(null);
    setGenerating(false);
    void refresh();
  }, [refresh]);

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

  const working = busy !== null;
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

  // ----- Generate flow -----
  const generateFlow = generating && (
    <section className="space-y-4" aria-labelledby="ds-generate">
      <SectionHeader id="ds-generate" title={t('context.design.generateTitle')} />
      {!directions && (
        <div className="max-w-2xl space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ds-product">{t('context.design.brief.product')}</Label>
            <Textarea
              id="ds-product"
              rows={3}
              value={brief.product}
              placeholder={t('context.design.brief.productPlaceholder')}
              onChange={(e) => setBrief({ ...brief, product: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ds-audience">{t('context.design.brief.audience')}</Label>
            <Input id="ds-audience" value={brief.audience} placeholder={t('context.design.brief.audiencePlaceholder')} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ds-mood">{t('context.design.brief.mood')}</Label>
            <Input id="ds-mood" value={brief.mood} placeholder={t('context.design.brief.moodPlaceholder')} onChange={(e) => setBrief({ ...brief, mood: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={!brief.product.trim() || working}
              onClick={() => void run('propose', () => window.electronAPI.design.propose(projectId, brief), setDirections)}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {t('context.design.propose')}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setGenerating(false)}>
              {t('buttons.cancel')}
            </Button>
          </div>
        </div>
      )}
      {directions && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('context.design.chooseDirection')}</p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {directions.map((d) => (
              <DirectionCard
                key={d.id}
                direction={d}
                disabled={working}
                onUse={() =>
                  void run('write', () => window.electronAPI.design.write(projectId, brief, d), (data) => {
                    setInfo(data);
                    setGenerating(false);
                    setDirections(null);
                  })
                }
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={working} onClick={() => void run('propose', () => window.electronAPI.design.propose(projectId, brief), setDirections)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('context.design.otherDirections')}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setDirections(null)}>
              {t('context.design.editBrief')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const qaModes: DesignQaMode[] = ['block', 'warn', 'off'];

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-10 p-6">
        {error && (
          <p role="alert" className="border-l-2 border-destructive bg-muted px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        )}
        {progressLine}

        {!info.exists && !generating && (
          <section className="space-y-4" aria-labelledby="ds-empty">
            <SectionHeader id="ds-empty" title={t('context.design.title')} />
            <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.emptyBody')}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="flex flex-col gap-3 border border-border p-4">
                <ScanSearch className="h-5 w-5 text-foreground" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{t('context.design.extractTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('context.design.extractBody')}</p>
                </div>
                <Button className="mt-auto" variant="outline" disabled={working} onClick={() => void run('extract', () => window.electronAPI.design.extract(projectId), setInfo)}>
                  {t('context.design.extract')}
                </Button>
              </div>
              <div className="flex flex-col gap-3 border border-foreground p-4">
                <Sparkles className="h-5 w-5 text-foreground" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{t('context.design.generateTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('context.design.generateBody')}</p>
                </div>
                <Button className="mt-auto" disabled={working} onClick={() => setGenerating(true)}>
                  {t('context.design.generate')}
                </Button>
              </div>
              <div className="flex flex-col gap-3 border border-border p-4">
                <Pencil className="h-5 w-5 text-foreground" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{t('context.design.repoTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('context.design.repoBody')}</p>
                </div>
                <Input value={repoPath} placeholder="design/DESIGN-SYSTEM.md" className="font-mono" onChange={(e) => setRepoPath(e.target.value)} />
                <Button variant="outline" disabled={!repoPath.trim() || working} onClick={() => void updateSettings({ designSystemPath: repoPath.trim() })}>
                  {t('context.design.useFile')}
                </Button>
              </div>
            </div>
          </section>
        )}

        {!info.exists && <DesignReferences projectId={projectId} />}

        {generateFlow}

        {info.exists && !generating && (
          <>
            <section className="space-y-4" aria-labelledby="ds-overview">
              <SectionHeader
                id="ds-overview"
                title={t('context.design.title')}
                meta={`${info.markdownPath}${info.source === 'repo' ? ` · ${t('context.design.inRepo')}` : ''}`}
                action={
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={working} onClick={() => setConfirmReplace('extract')}>
                      <ScanSearch className="mr-1.5 h-3.5 w-3.5" />
                      {t('context.design.extractAgain')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={working} onClick={() => setConfirmReplace('generate')}>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      {t('context.design.generateNew')}
                    </Button>
                  </div>
                }
              />
              {confirmReplace && (
                <div role="alertdialog" aria-labelledby="ds-replace" className="flex flex-wrap items-center justify-between gap-3 border border-foreground bg-card px-4 py-3">
                  <p id="ds-replace" className="max-w-prose text-sm text-foreground">
                    {info.source === 'repo'
                      ? t('context.design.replaceRepo', { path: info.markdownPath })
                      : t('context.design.replaceApp')}
                  </p>
                  <div className="flex gap-2">
                    {/* Focus starts on Cancel (design system: confirmation dialogs) */}
                    <Button variant="outline" size="sm" autoFocus onClick={() => setConfirmReplace(null)}>
                      {t('buttons.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        const kind = confirmReplace;
                        setConfirmReplace(null);
                        if (kind === 'extract') void run('extract', () => window.electronAPI.design.extract(projectId), setInfo);
                        else setGenerating(true);
                      }}
                    >
                      {t('context.design.replace')}
                    </Button>
                  </div>
                </div>
              )}
              {info.tokensError && <Notice>{info.tokensError}</Notice>}
              {info.tokens ? <TokensView tokens={info.tokens} /> : <Notice>{t('context.design.noTokens')}</Notice>}
            </section>

            <ApplyDesignSystem projectId={projectId} />

            <DesignReferences projectId={projectId} />

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
                    <span className={cn('text-xs', info.qaMode === mode ? 'text-background/80' : 'text-muted-foreground')}>
                      {t(`context.design.qaModes.${mode}Hint`)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        {!generating && (
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
                    <Button size="sm" disabled={busy === 'storybook'} onClick={() => void run('storybook', () => window.electronAPI.design.startStorybook(projectId), (d) => {
                      setStorybookUrl(d.url);
                      // Storybook opens in the browser, not inside the app
                      void window.electronAPI.openExternal(d.url);
                    })}>
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
              <Switch
                id="ds-storybook-enabled"
                checked={info.storybook.enabled}
                onCheckedChange={(checked) => void updateSettings({ storybookEnabled: checked })}
              />
            </div>
            {storybookUrl && (
              <Notice>
                {t('context.design.storybook.runningAt')}{' '}
                <button type="button" onClick={() => void window.electronAPI.openExternal(storybookUrl)} className="font-mono text-foreground underline underline-offset-4">
                  {storybookUrl}
                </button>
              </Notice>
            )}
            {!info.storybook.detected && info.storybook.enabled && (
              <EmptyState compact title={t('context.design.storybook.pendingTitle')} body={t('context.design.storybook.pendingBody')} />
            )}
          </section>
        )}

        {info.exists && !generating && (
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
        )}
      </div>
    </ScrollArea>
  );
}
