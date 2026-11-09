/**
 * Preview → Notes: while open, the page outlines elements and takes a click (an element)
 * or a drag (a region) as a note; the owner types it here. Notes are numbered pins on
 * their pages, kept as a draft until sent as one task.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';

import type { PreviewNote, PreviewOverlayEvent } from '../../../shared/types';
import { Button } from '../ui/button';

type Picked = Extract<PreviewOverlayEvent, { type: 'picked' }>;

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 64);

export function NotesPanel({ projectId, taskId, ready, onSend }: {
  projectId: string;
  /** A task's preview: its own draft, and the notes go back into that task */
  taskId?: string;
  ready: boolean;
  /** Makes the task; true when it was made */
  onSend: (notes: PreviewNote[], title: string, quickFix: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation(['tasks']);
  const [notes, setNotes] = useState<PreviewNote[]>([]);
  const [picking, setPicking] = useState(true);
  const [pending, setPending] = useState<Picked | null>(null);
  const [draft, setDraft] = useState('');
  const [route, setRoute] = useState<string | null>(null);
  const [detached, setDetached] = useState<number[]>([]);
  const [sending, setSending] = useState<{ title: string; quick: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusAfterRoute = useRef<number | null>(null);
  const api = window.electronAPI.preview;

  useEffect(() => {
    let live = true;
    void (taskId ? api.loadNotes(projectId, taskId) : api.loadNotes(projectId)).then((result) => {
      if (live && result.success && result.data) setNotes(result.data);
    });
    return () => {
      live = false;
    };
  }, [api, projectId, taskId]);

  useEffect(
    () =>
      api.onOverlayEvent((event) => {
        if (event.type === 'picked') {
          setPending(event);
          setDraft('');
        } else if (event.type === 'escape') {
          setPicking(false);
        } else if (event.type === 'detached') {
          setDetached(event.ns);
        } else if (event.type === 'route') {
          setRoute(event.route);
          setDetached([]);
        }
      }),
    [api],
  );

  useEffect(() => {
    void api.setNotesMode(ready && picking);
  }, [api, ready, picking]);
  useEffect(() => () => void api.setNotesMode(false), [api]);

  // The pins of the page being shown
  useEffect(() => {
    if (route === null) return;
    void api.setPins(notes.filter((note) => note.route === route).map((note) => ({ n: note.n, selector: note.pick.selector })));
    if (focusAfterRoute.current !== null && notes.some((n) => n.n === focusAfterRoute.current && n.route === route)) {
      void api.focusPin(focusAfterRoute.current);
      focusAfterRoute.current = null;
    }
  }, [api, notes, route]);

  const store = useCallback(
    (next: PreviewNote[]) => {
      setNotes(next);
      void (taskId ? api.saveNotes(projectId, next, taskId) : api.saveNotes(projectId, next));
    },
    [api, projectId, taskId],
  );

  const save = () => {
    if (!pending || !draft.trim()) return;
    const n = notes.reduce((max, note) => Math.max(max, note.n), 0) + 1;
    store([...notes, { id: newId(), n, route: pending.route, width: pending.width, text: draft.trim(), pick: pending.pick, image: pending.image, createdAt: new Date().toISOString() }]);
    setPending(null);
    setDraft('');
  };

  const open = (note: PreviewNote) => {
    if (note.route === route) {
      void api.focusPin(note.n);
      return;
    }
    focusAfterRoute.current = note.n;
    void api.navigate({ url: note.route });
  };

  const send = async () => {
    if (!sending) return;
    setBusy(true);
    setError(null);
    try {
      if (await onSend(notes, sending.title, sending.quick)) {
        store([]);
        setSending(null);
      } else setError(t('preview.notes.sendFailed'));
    } finally {
      setBusy(false);
    }
  };

  const routes = [...new Set(notes.map((note) => note.route))];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          type="button"
          role="switch"
          aria-checked={picking}
          aria-label={t('preview.notes.pick')}
          onClick={() => setPicking((on) => !on)}
          className={`inline-flex h-11 items-center px-3 text-sm font-medium ${picking ? 'bg-primary text-primary-foreground' : 'border border-foreground text-foreground'}`}
        >
          {t('preview.notes.pick')}
        </button>
        <p className="flex-1 text-xs text-muted-foreground">{picking ? t('preview.notes.howTo') : t('preview.notes.off')}</p>
      </div>

      {pending && (
        <div className="space-y-2 border-b border-border p-3">
          {pending.image && <img src={pending.image} alt="" className="max-h-32 border border-border" />}
          <p className="break-all font-mono text-xs text-muted-foreground">
            {`${pending.route} · ${pending.pick.selector}${pending.pick.frames[0] ? ` · ${pending.pick.frames[0].file}:${pending.pick.frames[0].line ?? ''}` : ''}`}
          </p>
          <label htmlFor="preview-note-text" className="block text-sm font-medium">{t('preview.notes.textLabel')}</label>
          <textarea
            id="preview-note-text"
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setPending(null);
              }
            }}
            placeholder={t('preview.notes.placeholder')}
            className="w-full border border-border bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!draft.trim()} onClick={save}>{t('preview.notes.save')}</Button>
            <Button size="sm" variant="outline" onClick={() => setPending(null)}>{t('preview.notes.cancel')}</Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {notes.length === 0 && !pending && <p className="text-sm text-muted-foreground">{t('preview.notes.empty')}</p>}
        {routes.map((page) => (
          <section key={page} className="mb-3">
            <h3 className="mb-1 font-mono text-xs text-muted-foreground">{page}</h3>
            <ul className="space-y-1">
              {notes.filter((note) => note.route === page).map((note) => (
                <li key={note.id} className="flex items-start gap-2 border border-border bg-background p-2">
                  <span className="inline-flex h-5 min-w-5 items-center justify-center bg-[var(--vt-signal)] px-1 text-xs font-semibold text-white">{note.n}</span>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(note)}>
                    <span className="block whitespace-pre-wrap text-sm text-foreground">{note.text}</span>
                    {note.route === route && detached.includes(note.n) && (
                      <span className="mt-0.5 block text-xs text-destructive">{t('preview.notes.detached')}</span>
                    )}
                  </button>
                  <Button size="icon" variant="ghost" aria-label={t('preview.notes.delete')} onClick={() => store(notes.filter((other) => other.id !== note.id))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {notes.length > 0 && (
        <div className="space-y-2 border-t border-border p-3">
          {sending ? (
            <>
              {!taskId && (<>
              <label htmlFor="preview-notes-title" className="block text-sm font-medium">{t('preview.notes.title')}</label>
              <input
                id="preview-notes-title"
                value={sending.title}
                onChange={(e) => setSending({ ...sending, title: e.target.value })}
                className="h-11 w-full border border-border bg-background px-2 text-sm"
              />
              <fieldset className="space-y-1">
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="preview-notes-mode" checked={sending.quick} onChange={() => setSending({ ...sending, quick: true })} />
                  <span><span className="font-medium">{t('preview.notes.quick')}</span> <span className="text-muted-foreground">{t('preview.notes.quickHint')}</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="preview-notes-mode" checked={!sending.quick} onChange={() => setSending({ ...sending, quick: false })} />
                  <span><span className="font-medium">{t('preview.notes.full')}</span> <span className="text-muted-foreground">{t('preview.notes.fullHint')}</span></span>
                </label>
              </fieldset>
              </>)}
              {taskId && <p className="text-sm text-muted-foreground">{t('preview.notes.sendBackHint')}</p>}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void send()}>{t('preview.notes.sendNow')}</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setSending(null)}>{t('preview.notes.cancel')}</Button>
              </div>
            </>
          ) : (
            <Button size="sm" onClick={() => setSending(taskId ? { title: '', quick: false } : { title: notes[0].text.replace(/\s+/g, ' ').trim().slice(0, 80), quick: true })}>
              {t(taskId ? 'preview.notes.sendBack' : 'preview.notes.send', { count: notes.length })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
