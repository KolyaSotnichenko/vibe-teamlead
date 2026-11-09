/**
 * Preview → Mail: what the app sent, caught locally by Mailpit when the project's settings
 * configure SMTP. Nothing leaves the machine; links in a message open in the preview.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewMailMessage, PreviewMailSummary } from '../../../shared/types';

const REFRESH_MS = 3000;

export function MailPanel({ projectId, mail, reason }: { projectId: string; mail?: 'started' | 'unavailable'; reason?: string }) {
  const { t } = useTranslation(['tasks']);
  const [list, setList] = useState<PreviewMailSummary[]>([]);
  const [open, setOpen] = useState<PreviewMailMessage | null>(null);

  useEffect(() => {
    if (mail !== 'started') return;
    let live = true;
    const load = () =>
      void window.electronAPI.preview.mailList(projectId).then((result) => {
        if (live && result.success && result.data) setList(result.data);
      });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId, mail]);

  if (mail !== 'started') {
    return (
      <div className="space-y-2 p-3 text-sm text-muted-foreground">
        <p>{mail === 'unavailable' ? reason ?? t('preview.mail.unavailable') : t('preview.mail.none')}</p>
      </div>
    );
  }

  const read = async (id: string) => {
    const result = await window.electronAPI.preview.mailGet(projectId, id);
    if (result.success) setOpen(result.data ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      <ul className="max-h-[40%] overflow-auto border-b border-border">
        {list.length === 0 && <li className="p-3 text-sm text-muted-foreground">{t('preview.mail.empty')}</li>}
        {list.map((message) => (
          <li key={message.id}>
            <button type="button" onClick={() => void read(message.id)} className={`block w-full border-b border-border p-2 text-left ${open?.id === message.id ? 'bg-muted' : ''}`}>
              <span className="block text-sm font-medium text-foreground">{message.subject}</span>
              <span className="block truncate text-xs text-muted-foreground">{`${message.to.join(', ')} · ${message.from}`}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <h3 className="text-sm font-semibold text-foreground">{open.subject}</h3>
          {open.links.length > 0 && (
            <ul className="space-y-1">
              {open.links.map((link) => (
                <li key={link}>
                  <button type="button" className="break-all text-left text-sm text-[var(--vt-signal)] underline" onClick={() => void window.electronAPI.preview.navigate({ url: link })}>
                    {link}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">{open.text}</pre>
        </div>
      )}
    </div>
  );
}
