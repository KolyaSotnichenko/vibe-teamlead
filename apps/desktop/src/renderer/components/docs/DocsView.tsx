/**
 * Documentation: how every mechanism of Vibe Teamlead works, one page per topic,
 * in the interface language. Searchable; Mermaid diagrams render inline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Search } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { WorkspaceMarkdown } from '../task-detail/workspace/workspace-ui';
import { docsFor, searchDocs } from '../../docs';

const ISSUES_URL = 'https://github.com/KolyaSotnichenko/vibe-teamlead/issues';

export function DocsView({ initialTopic }: { initialTopic?: string }) {
  const { t, i18n } = useTranslation('navigation');
  const topics = useMemo(() => docsFor(i18n.language || 'en'), [i18n.language]);
  const [slug, setSlug] = useState(initialTopic ?? topics[0]?.slug);
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => searchDocs(topics, query), [topics, query]);
  const topic = topics.find((x) => x.slug === slug) ?? topics[0];

  useEffect(() => {
    // A new topic starts at its top
    contentRef.current?.closest('[data-radix-scroll-area-viewport]')?.scrollTo({ top: 0 });
  }, [slug]);

  return (
    <div className="flex h-full overflow-hidden">
      <nav aria-label={t('docs.title')} className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="space-y-3 border-b border-border p-4">
          <h1 className="text-lg font-semibold text-foreground">{t('docs.title')}</h1>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="text"
              role="searchbox"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('docs.search')}
              aria-label={t('docs.search')}
              className="pl-9"
            />
          </div>
        </div>
        <ScrollArea className="flex-1">
          <ul className="py-2">
            {matches.map(({ topic: item, snippet }) => (
              <li key={item.slug}>
                <button
                  type="button"
                  onClick={() => setSlug(item.slug)}
                  aria-current={item.slug === topic?.slug ? 'page' : undefined}
                  className={cn(
                    'w-full border-l-2 px-4 py-2 text-left text-sm',
                    item.slug === topic?.slug
                      ? 'border-foreground bg-accent font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {item.title}
                  {snippet && <span className="mt-0.5 block text-xs font-normal text-muted-foreground line-clamp-2">{snippet}</span>}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">{t('docs.nothingFound')}</li>}
          </ul>
        </ScrollArea>
        <div className="border-t border-border p-4">
          <Button variant="outline" size="sm" className="w-full" onClick={() => window.open(ISSUES_URL, '_blank')}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            {t('docs.reportProblem')}
          </Button>
        </div>
      </nav>

      <ScrollArea className="flex-1">
        <article ref={contentRef} className="mx-auto max-w-3xl px-8 py-8">
          {topic ? (
            <>
              <h1 className="mb-6 text-3xl font-bold tracking-tight text-foreground">{topic.title}</h1>
              <WorkspaceMarkdown markdown={topic.body} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('docs.nothingFound')}</p>
          )}
        </article>
      </ScrollArea>
    </div>
  );
}
