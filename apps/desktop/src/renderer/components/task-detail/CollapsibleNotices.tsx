/**
 * The notices above a task's tabs (screens to check, the app's checks, CI, security...), folding
 * to one line of their titles. With several open they took most of the window and the task itself
 * was out of sight. The notices stay mounted while folded, so they keep loading what they show.
 * The choice is remembered for every task.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const KEY = 'vt.taskNotices.folded';

function readFolded(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function CollapsibleNotices({ children }: { children: ReactNode }) {
  const { t } = useTranslation('tasks');
  const [folded, setFolded] = useState(readFolded);
  const [titles, setTitles] = useState<string[]>([]);
  const inner = useRef<HTMLDivElement>(null);

  // Which notices show right now: they load by themselves, so the box is watched
  useEffect(() => {
    const box = inner.current;
    if (!box) return;
    const read = () => setTitles(Array.from(box.querySelectorAll(':scope > * h3')).map((h) => (h.textContent ?? '').trim()).filter(Boolean));
    read();
    const observer = new MutationObserver(read);
    observer.observe(box, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    const next = !folded;
    setFolded(next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // only remembered while the window is open
    }
  };

  return (
    <div className="mt-3">
      {titles.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!folded}
            aria-label={t(folded ? 'taskNotices.show' : 'taskNotices.hide')}
            className="flex shrink-0 items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-2"
          >
            {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {t(folded ? 'taskNotices.show' : 'taskNotices.hide')}
          </button>
          {folded && <span className="truncate text-sm text-foreground">{titles.join(' · ')}</span>}
        </div>
      )}
      <div ref={inner} hidden={folded} className="mt-2 space-y-3 empty:hidden">
        {children}
      </div>
    </div>
  );
}
