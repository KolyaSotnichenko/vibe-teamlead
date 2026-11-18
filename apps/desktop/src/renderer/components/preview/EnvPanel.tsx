/**
 * Preview → Environment: in plain words first (what the preview started, what is empty and
 * what that may break, what needs the owner's own keys), then every setting each service
 * got or will get, with where it came from, behind a fold per service. Secrets are masked.
 * The owner can set a value for one service, add one, or go back to the automatic value;
 * "Apply and restart" restarts the services with them. Values are never read from `.env`.
 */

import { Eye, EyeOff, Pencil } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewEnvReport, PreviewEnvVar, PreviewStage, ProjectSettings } from '../../../shared/types';
import { updateProjectSettings } from '../../stores/project-store';
import { Notice } from '../task-detail/workspace/workspace-ui';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { isEmptyVar, isSecretVar, sortVars, summarizeEnv } from './env-summary';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KIND_NAMES: Record<string, string> = { postgres: 'Postgres', mysql: 'MySQL', redis: 'Redis', mongo: 'MongoDB' };

type Overrides = Pick<ProjectSettings, 'previewEnv' | 'previewServiceEnv'>;

function Summary({ report }: { report: PreviewEnvReport }) {
  const { t } = useTranslation(['tasks']);
  const summary = summarizeEnv(report);
  const parts = [
    ...summary.databases.map((kind) => t('preview.env.partDatabase', { kind: KIND_NAMES[kind] ?? kind })),
    ...(summary.mail ? [t('preview.env.partMail')] : []),
  ].join(t('preview.env.and'));
  const features = (list: string[]) => list.map((f) => t(`preview.env.feature.${f}`)).join(', ');
  return (
    <div className="space-y-2 text-sm">
      {summary.dockerUnavailable && parts && (
        <p role="alert" className="border-l-2 border-[var(--vt-signal)] bg-muted px-3 py-2 text-foreground">{t('preview.env.docker', { parts })}</p>
      )}
      {!summary.dockerUnavailable && parts && <p>{t(report.running ? 'preview.env.ready' : 'preview.env.willStart', { parts })}</p>}
      {summary.empty > 0 ? (
        <p>{t('preview.env.empty', { count: summary.empty, features: features(summary.features) })}</p>
      ) : (
        !parts && <p>{t('preview.env.allSet')}</p>
      )}
      {summary.outside.length > 0 && <p>{t('preview.env.outside', { features: features(summary.outside) })}</p>}
      <p className="text-muted-foreground">{t('preview.env.noAutomatic')}</p>
    </div>
  );
}

function Row({ service, v, onSave, onClear }: {
  service: string;
  v: PreviewEnvVar;
  onSave: (name: string, value: string) => Promise<boolean>;
  onClear: (v: PreviewEnvVar) => Promise<boolean>;
}) {
  const { t } = useTranslation(['tasks']);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const secret = isSecretVar(v);
  const empty = isEmptyVar(v);
  const blocked = v.source === 'blocked' || v.automatic?.source === 'blocked';
  const owned = v.source === 'serviceOverride' || v.source === 'override';
  const shown = v.pending ? t('preview.env.pending') : secret && !revealed && v.value ? '••••••••' : v.value;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (editing !== null && (await onSave(v.name, editing))) setEditing(null);
  };

  return (
    <li className="space-y-1 border-b border-border py-2" data-service={service}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{v.name}</span>
        {empty && <span className="bg-[var(--vt-signal-text)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--vt-paper)]">{t('preview.env.emptyMark')}</span>}
        {secret && v.value && !v.pending && (
          <Button variant="ghost" size="icon" aria-label={t(revealed ? 'preview.env.hide' : 'preview.env.reveal', { name: v.name })} onClick={() => setRevealed(!revealed)}>
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
        {v.source !== 'port' && editing === null && (
          <Button variant="ghost" size="icon" aria-label={t('preview.env.edit', { name: v.name })} onClick={() => setEditing(v.value)}>
            <Pencil className="h-4 w-4" />
          </Button>
        )}
      </div>
      {editing === null ? (
        <div className={`break-all font-mono text-xs ${v.pending ? 'text-muted-foreground' : 'text-foreground'}`}>{shown || ' '}</div>
      ) : (
        <form onSubmit={save} className="space-y-2">
          <Input
            aria-label={t('preview.env.value', { name: v.name })}
            className="font-mono text-xs"
            type={secret && !revealed ? 'password' : 'text'}
            value={editing}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">{t('preview.env.save')}</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)}>{t('preview.env.cancel')}</Button>
          </div>
        </form>
      )}
      <p className="text-xs text-muted-foreground">{t(`preview.env.source.${v.source}`)}</p>
      {blocked && (editing !== null || owned) && <p className="text-xs text-[var(--vt-signal-text)]">{t('preview.env.realWarning')}</p>}
      {v.source === 'override' && <p className="text-xs text-muted-foreground">{t('preview.env.allServices')}</p>}
      {owned && (
        <Button variant="outline" size="sm" onClick={() => void onClear(v)}>{t('preview.env.useAutomatic')}</Button>
      )}
    </li>
  );
}

function AddVar({ onAdd }: { onAdd: (name: string, value: string) => Promise<boolean> }) {
  const { t } = useTranslation(['tasks']);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const valid = NAME.test(name.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (valid && (await onAdd(name.trim(), value))) {
      setName('');
      setValue('');
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 pt-2">
      <p className="text-xs font-medium text-foreground">{t('preview.env.addTitle')}</p>
      <div className="flex gap-2">
        <Input aria-label={t('preview.env.addName')} placeholder={t('preview.env.addName')} className="font-mono text-xs" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label={t('preview.env.addValue')} placeholder={t('preview.env.addValue')} className="font-mono text-xs" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" size="sm" variant="outline" disabled={!valid}>{t('preview.env.add')}</Button>
      </div>
      {name.trim() !== '' && !valid && <p className="text-xs text-[var(--vt-signal-text)]">{t('preview.env.badName')}</p>}
    </form>
  );
}

export function EnvPanel({ projectId, taskId, settings, stage }: { projectId: string; taskId?: string; settings: Overrides; stage?: PreviewStage }) {
  const { t } = useTranslation(['tasks']);
  const [report, setReport] = useState<PreviewEnvReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [emptyOnly, setEmptyOnly] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // The preview the newest answer may be shown for: an answer for another one is dropped
  const key = `${projectId}\0${taskId ?? ''}`;
  const current = useRef(key);
  current.current = key;
  const load = useCallback(async () => {
    const result = await (taskId ? window.electronAPI.preview.env(projectId, taskId) : window.electronAPI.preview.env(projectId));
    if (current.current !== key) return;
    if (result.success && result.data) {
      setReport(result.data);
      setFailed(false);
    } else setFailed(true);
  }, [projectId, taskId, key]);
  // Again when the preview comes up, fails or stops: the values come from the running services then
  // biome-ignore lint/correctness/useExhaustiveDependencies: stage is the trigger to read again
  useEffect(() => {
    void load();
  }, [load, stage]);

  const write = async (patch: Overrides) => {
    const ok = await updateProjectSettings(projectId, patch);
    setSaveFailed(!ok);
    if (ok) await load();
    return ok;
  };
  const setValue = (service: string) => (name: string, value: string) => {
    const all = settings.previewServiceEnv ?? {};
    return write({ previewServiceEnv: { ...all, [service]: { ...(all[service] ?? {}), [name]: value } } });
  };
  const clear = (service: string) => (v: PreviewEnvVar) => {
    if (v.source === 'override') {
      const { [v.name]: _gone, ...rest } = settings.previewEnv ?? {};
      return write({ previewEnv: rest });
    }
    const all = settings.previewServiceEnv ?? {};
    const { [v.name]: _gone, ...rest } = all[service] ?? {};
    return write({ previewServiceEnv: { ...all, [service]: rest } });
  };
  const apply = async () => {
    setApplying(true);
    try {
      await (taskId ? window.electronAPI.preview.restartServices(projectId, taskId) : window.electronAPI.preview.restartServices(projectId));
      await load();
    } finally {
      setApplying(false);
    }
  };

  if (!report) {
    return <p className="p-3 text-sm text-muted-foreground">{t(failed ? 'preview.env.failed' : 'preview.env.loading')}</p>;
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="space-y-3 border-b border-border p-3">
        <Summary report={report} />
        <p className="text-xs text-muted-foreground">{t(report.running ? 'preview.env.running' : 'preview.env.notRunning')}</p>
        {report.restartNeeded && <Notice>{t('preview.env.restartNeeded')}</Notice>}
        {saveFailed && <p role="alert" className="text-sm text-[var(--vt-signal-text)]">{t('preview.env.saveFailed')}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={report.restartNeeded ? 'default' : 'outline'} disabled={applying} onClick={() => void apply()}>
            {t(applying ? 'preview.env.applying' : 'preview.env.apply')}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={emptyOnly} onChange={(e) => setEmptyOnly(e.target.checked)} />
            {t('preview.env.emptyOnly')}
          </label>
        </div>
      </div>
      <div className="space-y-2 p-3">
        {report.services.map(({ service, vars }) => {
          const empty = vars.filter(isEmptyVar).length;
          const shown = sortVars(emptyOnly ? vars.filter(isEmptyVar) : vars);
          return (
            <details key={service} className="border border-border" open={emptyOnly || undefined}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                {t('preview.env.details', { service, count: vars.length, empty })}
              </summary>
              <div className="px-3 pb-3">
                {shown.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t('preview.env.none')}</p>}
                <ul>
                  {shown.map((v) => (
                    <Row key={v.name} service={service} v={v} onSave={setValue(service)} onClear={clear(service)} />
                  ))}
                </ul>
                <AddVar onAdd={setValue(service)} />
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
