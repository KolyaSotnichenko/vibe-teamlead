/** Above the preview: history, address, width presets, and resetting the preview's data. */

import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewNavigation } from '../../../shared/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export const PREVIEW_WIDTHS = [375, 768, 1280, null] as const;
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number];

/** What the side panel shows, or null when it is closed */
export type PreviewSide = 'notes' | 'ux' | null;

export function PreviewToolbar({ url, width, onWidth, onNavigate, onReset, onEditServices, disabled, side, onSide }: {
  url?: string;
  width: PreviewWidth;
  onWidth: (width: PreviewWidth) => void;
  onNavigate: (navigation: PreviewNavigation) => void;
  onReset: () => void;
  onEditServices: () => void;
  disabled: boolean;
  side: PreviewSide;
  onSide: (side: PreviewSide) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const [address, setAddress] = useState(url ?? '');
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setAddress(url ?? ''), [url]);

  const go = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) onNavigate({ url: address.trim() });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <Button variant="ghost" size="icon" aria-label={t('preview.toolbar.back')} disabled={disabled} onClick={() => onNavigate({ action: 'back' })}><ArrowLeft className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" aria-label={t('preview.toolbar.forward')} disabled={disabled} onClick={() => onNavigate({ action: 'forward' })}><ArrowRight className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" aria-label={t('preview.toolbar.reload')} disabled={disabled} onClick={() => onNavigate({ action: 'reload' })}><RotateCw className="h-4 w-4" /></Button>
      <form onSubmit={go} className="min-w-48 flex-1">
        <Input aria-label={t('preview.toolbar.address')} className="font-mono text-xs" value={address} disabled={disabled} onChange={(e) => setAddress(e.target.value)} />
      </form>
      <div className="flex" role="group" aria-label={t('preview.toolbar.width')}>
        {PREVIEW_WIDTHS.map((preset) => (
          <Button key={String(preset)} variant={width === preset ? 'default' : 'outline'} size="sm" onClick={() => onWidth(preset)}>
            {preset ?? t('preview.toolbar.full')}
          </Button>
        ))}
      </div>
      {confirmReset ? (
        <span className="flex items-center gap-2 text-sm">
          {t('preview.toolbar.resetConfirm')}
          <Button variant="destructive" size="sm" onClick={() => { setConfirmReset(false); onReset(); }}>{t('preview.toolbar.resetYes')}</Button>
          <Button variant="outline" size="sm" onClick={() => setConfirmReset(false)}>{t('preview.toolbar.resetNo')}</Button>
        </span>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>{t('preview.toolbar.reset')}</Button>
      )}
      <Button variant={side === 'ux' ? 'default' : 'outline'} size="sm" aria-pressed={side === 'ux'} onClick={() => onSide(side === 'ux' ? null : 'ux')}>
        {t('preview.toolbar.ux')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onEditServices}>{t('preview.toolbar.services')}</Button>
    </div>
  );
}
