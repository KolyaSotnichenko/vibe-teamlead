/**
 * Preview → Logs: the end of each running service's log, refreshed while open. Links in a
 * line (a verification link a "console" mail provider prints) open in the preview.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '../ui/input';

const REFRESH_MS = 2000;
const URL = /https?:\/\/[^\s"'<>)]+/g;

function Line({ text }: { text: string }) {
  const parts: Array<string | { url: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL)) {
    parts.push(text.slice(last, match.index), { url: match[0] });
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <div className="whitespace-pre-wrap break-all">
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <button key={i} type="button" className="text-[var(--vt-signal)] underline" onClick={() => void window.electronAPI.preview.navigate({ url: part.url })}>
            {part.url}
          </button>
        ),
      )}
    </div>
  );
}

export function LogsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation(['tasks']);
  const [logs, setLogs] = useState<Array<{ service: string; text: string }>>([]);
  const [service, setService] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      void window.electronAPI.preview.logs(projectId).then((result) => {
        if (live && result.success && result.data) setLogs(result.data);
      });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId]);

  const shown = logs.find((log) => log.service === service) ?? logs[0];
  const lines = useMemo(() => {
    const all = (shown?.text ?? '').split('\n').filter(Boolean);
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((line) => line.toLowerCase().includes(needle)) : all;
  }, [shown, query]);

  useEffect(() => {
    if (!query) end.current?.scrollIntoView?.({ block: 'end' });
  }, [lines.length, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('preview.logs.services')}>
          {logs.map((log) => (
            <button
              key={log.service}
              type="button"
              aria-pressed={log.service === shown?.service}
              onClick={() => setService(log.service)}
              className={`inline-flex h-9 items-center px-3 text-sm ${log.service === shown?.service ? 'bg-primary text-primary-foreground' : 'border border-border text-foreground'}`}
            >
              {log.service}
            </button>
          ))}
        </div>
        <Input aria-label={t('preview.logs.search')} placeholder={t('preview.logs.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs text-foreground">
        {logs.length === 0 && <p className="font-sans text-sm text-muted-foreground">{t('preview.logs.empty')}</p>}
        {lines.map((line, i) => (
          <Line key={i} text={line} />
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
