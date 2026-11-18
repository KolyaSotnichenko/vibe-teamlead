/**
 * Context → Architecture: the project's cloud architecture (TerraVision, experimental).
 * The latest one an architect designed and the one the app drew from the Terraform
 * code after the latest merge that changed it, side by side; the decisions (ADRs) of
 * merged tasks; and a button that creates a task to design it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { EmptyState, Notice, SectionHeader } from '../task-detail/workspace/workspace-ui';
import { createTask } from '../../stores/task-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useToast } from '../../hooks/use-toast';
import { openTask } from '../../lib/open-task';
import { AdrRow } from '../task-detail/workspace/ArchitectureTab';
import { CLOUD_DESIGN_MARKER, type CloudArchitectureFile, type CloudArchitectureView, type CloudDecision } from '../../../shared/types/cloud-architecture';

interface Props {
  projectId: string;
}

function OpenButton({ label, onClick, icon = 'external' }: { label: string; onClick: () => void; icon?: 'external' | 'folder' }) {
  const Icon = icon === 'folder' ? FolderOpen : ExternalLink;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 shrink-0 items-center gap-2 border border-foreground px-4 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
      {label}
    </button>
  );
}

function Diagram({ src, alt }: { src: string; alt: string }) {
  // TerraVision draws on white; keep it on a paper panel in both themes. An SVG in <img> runs no scripts.
  return (
    <div className="overflow-auto border border-border bg-[var(--vt-paper)] p-4">
      <img src={src} alt={alt} className="mx-auto h-auto max-w-full" />
    </div>
  );
}

export function CloudArchitectureTab({ projectId }: Props) {
  const { t, i18n } = useTranslation(['cloud']);
  const { toast } = useToast();
  const architectMode = useSettingsStore((s) => s.settings.architectMode);
  const [view, setView] = useState<CloudArchitectureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.cloudArchitecture.get(projectId);
      if (result.success && result.data) {
        setView(result.data);
        setError(null);
      } else setError(result.error ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return window.electronAPI.cloudArchitecture.onUpdated((id) => {
      if (id === projectId) void load();
    });
  }, [load, projectId]);

  const open = async (file: CloudArchitectureFile) => {
    const result = await window.electronAPI.cloudArchitecture.open(projectId, file);
    if (!result.success) toast({ title: t('cloud:tab.loadFailed'), description: result.error, variant: 'destructive' });
  };

  const architectOff = architectMode === 'never';
  const design = async () => {
    setCreating(true);
    try {
      const task = await createTask(projectId, t('cloud:tab.design.title'), `${t('cloud:tab.design.description')}\n\n${CLOUD_DESIGN_MARKER}`, {
        sourceType: 'manual',
        cloudArchitectureDesign: true,
        architectureOnly: true,
        requireReviewBeforeCoding: true,
      });
      toast(task ? { title: t('cloud:tab.design.created') } : { title: t('cloud:tab.design.failed'), variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const drawn = view?.fromCode?.drawn;
  const attempt = view?.fromCode?.lastAttempt;
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(i18n.language);
  };

  return (
    <ScrollArea className="h-full">
      <div className="space-y-8 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('cloud:tab.title')}</h2>
            <p className="max-w-prose text-sm text-muted-foreground">{t('cloud:tab.subtitle')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('cloud:tab.refresh')}
          </Button>
        </div>

        {error !== null && <Notice>{`${t('cloud:tab.loadFailed')}${error ? `: ${error}` : ''}`}</Notice>}

        {view && !view.enabled && (
          <Notice>
            <p>{t('cloud:tab.off')}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => window.dispatchEvent(new CustomEvent('open-app-settings', { detail: 'agent' }))}
            >
              {t('cloud:tab.openSettings')}
            </Button>
          </Notice>
        )}

        {view?.enabled && !view.tools.ready && (
          <Notice>
            <p>{t('cloud:tab.missingTools')}</p>
            <ul className="mt-1 space-y-1">
              {view.tools.missing.map((tool) => (
                <li key={tool}>
                  <span className="text-foreground">{t(`cloud:settings.tools.${tool}`)}</span> <code className="font-mono text-xs">{view.tools.hints[tool]}</code>
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {view && (
          <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
            <section aria-labelledby="cloud-designed" className="min-w-0 space-y-3">
              <SectionHeader id="cloud-designed" title={t('cloud:tab.designed.title')} />
              {view.designed ? (
                <>
                  <p className="text-sm text-muted-foreground">{t('cloud:tab.designed.fromTask', { task: view.designed.taskTitle })}</p>
                  {view.designed.svg && <Diagram src={view.designed.svg} alt={t('cloud:tab.designed.title')} />}
                  <div className="flex flex-wrap gap-2">
                    {view.designed.hasDrawio && <OpenButton label={t('cloud:tab.designed.openDrawio')} onClick={() => void open('designed-drawio')} />}
                    <OpenButton label={t('cloud:tab.designed.openSvg')} onClick={() => void open('designed-svg')} />
                  </div>
                </>
              ) : (
                <EmptyState compact title={t('cloud:tab.designed.title')} body={t('cloud:tab.designed.none')} />
              )}
            </section>

            <section aria-labelledby="cloud-from-code" className="min-w-0 space-y-3">
              <SectionHeader id="cloud-from-code" title={t('cloud:tab.fromCode.title')} />
              {attempt && attempt.status !== 'drawn' && (
                <Notice>{t(`cloud:tab.fromCode.status.${attempt.status}`, { commit: attempt.commit.slice(0, 7), detail: attempt.detail ?? '' })}</Notice>
              )}
              {drawn ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t('cloud:tab.fromCode.drawnFrom', { source: drawn.source, commit: drawn.commit.slice(0, 7), date: date(drawn.drawnAt) })}
                    {drawn.taskTitle ? ` ${t('cloud:tab.fromCode.afterTask', { task: drawn.taskTitle })}` : ''}
                  </p>
                  {view.fromCode?.svg && <Diagram src={view.fromCode.svg} alt={t('cloud:tab.fromCode.title')} />}
                  <div className="flex flex-wrap gap-2">
                    {drawn.files.drawio && <OpenButton label={t('cloud:tab.fromCode.openDrawio')} onClick={() => void open('drawio')} />}
                    {drawn.files.html && <OpenButton label={t('cloud:tab.fromCode.openHtml')} onClick={() => void open('html')} />}
                    {drawn.files.svg && <OpenButton label={t('cloud:tab.fromCode.openSvg')} onClick={() => void open('svg')} />}
                    <OpenButton icon="folder" label={t('cloud:tab.fromCode.openFolder')} onClick={() => void open('folder')} />
                  </div>
                </>
              ) : (
                <EmptyState compact title={t('cloud:tab.fromCode.title')} body={t('cloud:tab.fromCode.none')} />
              )}
            </section>
          </div>
        )}

        {view && (
          <section aria-labelledby="cloud-design" className="space-y-2">
            <Button onClick={() => void design()} disabled={creating || architectOff || !view.enabled || !view.tools.ready}>
              {t('cloud:tab.design.button')}
            </Button>
            <p className="max-w-prose text-xs text-muted-foreground">
              {t(!view.enabled ? 'cloud:tab.design.off' : !view.tools.ready ? 'cloud:tab.design.missingTools' : architectOff ? 'cloud:tab.design.architectOff' : 'cloud:tab.design.hint')}
            </p>
          </section>
        )}

        {view && (
          <section aria-labelledby="cloud-decisions" className="space-y-3">
            <SectionHeader id="cloud-decisions" title={t('cloud:tab.decisions.title')} meta={view.decisions.length ? String(view.decisions.length) : undefined} />
            {view.decisions.length === 0 ? (
              <EmptyState compact title={t('cloud:tab.decisions.title')} body={t('cloud:tab.decisions.none')} />
            ) : (
              <div className="space-y-4">
                {groupByTask(view.decisions).map((group) => (
                  <div key={group.taskId} className="border border-border">
                    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-foreground">{group.taskTitle}</span>
                      <button
                        type="button"
                        onClick={() => openTask(group.taskId)}
                        className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t('cloud:tab.decisions.openTaskLink')}
                      </button>
                    </div>
                    <ul>
                      {group.decisions.map((decision) => (
                        <AdrRow key={decision.fileName} adr={decision} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

/** Decisions grouped by task, the task with the newest decision first; within a task in ADR number order */
function groupByTask(decisions: CloudDecision[]): Array<{ taskId: string; taskTitle: string; decisions: CloudDecision[] }> {
  const groups = new Map<string, { taskId: string; taskTitle: string; decisions: CloudDecision[]; latest: number }>();
  for (const decision of decisions) {
    const group = groups.get(decision.taskId) ?? { taskId: decision.taskId, taskTitle: decision.taskTitle, decisions: [], latest: 0 };
    group.decisions.push(decision);
    group.latest = Math.max(group.latest, decision.at);
    groups.set(decision.taskId, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.latest - a.latest)
    .map((group) => ({ ...group, decisions: group.decisions.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true })) }));
}
