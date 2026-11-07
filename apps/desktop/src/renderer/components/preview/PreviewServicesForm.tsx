/**
 * What the Preview runs, confirmed once by the owner: the proposals from the
 * project's dev scripts, editable. Exactly one service is the page.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewService } from '../../../shared/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const NAME = /^[\w-]{1,40}$/;

/** What stops these services from being saved, or null. Pure. */
export function servicesProblem(services: PreviewService[]): 'page' | 'name' | 'command' | null {
  if (services.filter((s) => s.page).length !== 1) return 'page';
  if (services.some((s) => !NAME.test(s.name)) || new Set(services.map((s) => s.name)).size !== services.length) return 'name';
  if (services.some((s) => !s.command.trim())) return 'command';
  return null;
}

const urlEnvText = (urlEnv: PreviewService['urlEnv']) =>
  Object.entries(urlEnv ?? {}).map(([variable, service]) => `${variable}=${service}`).join(', ');

function parseUrlEnv(text: string): PreviewService['urlEnv'] {
  const pairs = text.split(',').map((part) => part.trim().split('=')).filter(([k, v]) => k && v);
  return pairs.length ? Object.fromEntries(pairs.map(([k, v]) => [k.trim(), v.trim()])) : undefined;
}

export function PreviewServicesForm({ initial, onSave, onCancel }: { initial: PreviewService[]; onSave: (services: PreviewService[]) => void; onCancel?: () => void }) {
  const { t } = useTranslation(['tasks']);
  const [services, setServices] = useState<PreviewService[]>(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const update = (index: number, patch: Partial<PreviewService>) =>
    setServices((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : patch.page ? { ...s, page: undefined } : s)));

  const save = () => {
    const found = servicesProblem(services);
    if (found) {
      setProblem(found);
      return;
    }
    onSave(services.map((s) => {
      const { page, urlEnv, portEnv, ...rest } = s;
      return { ...rest, ...(portEnv ? { portEnv } : {}), ...(page ? { page: true } : {}), ...(urlEnv && Object.keys(urlEnv).length ? { urlEnv } : {}) };
    }));
  };

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t('preview.services.intro')}</p>
      <div className="space-y-3">
        {services.map((service, index) => (
          <div key={index} className="grid grid-cols-[8rem_10rem_1fr_12rem_auto_auto] items-center gap-2 border-b border-border pb-3">
            <Input aria-label={t('preview.services.name')} value={service.name} onChange={(e) => update(index, { name: e.target.value })} />
            <Input aria-label={t('preview.services.dir')} value={service.dir} placeholder="." onChange={(e) => update(index, { dir: e.target.value })} />
            <Input aria-label={t('preview.services.command')} className="font-mono" value={service.command} onChange={(e) => update(index, { command: e.target.value })} />
            <Input aria-label={t('preview.services.urlEnv')} className="font-mono" placeholder="API_URL=api" defaultValue={urlEnvText(service.urlEnv)} onBlur={(e) => update(index, { urlEnv: parseUrlEnv(e.target.value) })} />
            <label className="flex items-center gap-1 text-sm">
              <input type="radio" name="preview-page" checked={!!service.page} onChange={() => update(index, { page: true })} />
              {t('preview.services.page')}
            </label>
            <Button variant="ghost" size="sm" onClick={() => setServices((list) => list.filter((_, i) => i !== index))}>
              {t('preview.services.remove')}
            </Button>
          </div>
        ))}
      </div>
      <Button variant="outline" size="sm" onClick={() => setServices((list) => [...list, { name: `service-${list.length + 1}`, dir: '', command: '' }])}>
        {t('preview.services.add')}
      </Button>
      {problem && (
        <p role="alert" className="text-sm text-destructive">{t(`preview.services.problem.${problem}`)}</p>
      )}
      <div className="flex gap-2">
        <Button onClick={save}>{t('preview.services.save')}</Button>
        {onCancel && <Button variant="outline" onClick={onCancel}>{t('preview.services.cancel')}</Button>}
      </div>
    </div>
  );
}
