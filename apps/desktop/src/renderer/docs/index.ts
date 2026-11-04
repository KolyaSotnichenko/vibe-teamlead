/**
 * The in-app documentation: one Markdown file per topic, per language
 * (src/renderer/docs/<lang>/NN-slug.md), bundled at build time.
 */

const files = import.meta.glob('./*/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface DocTopic {
  /** File name without extension, e.g. "08-design-system" */
  slug: string;
  title: string;
  /** Markdown without the title line */
  body: string;
}

/** Topics of one language from raw files. Pure — tested directly. */
export function parseDocs(raw: Record<string, string>, lang: string): DocTopic[] {
  return Object.entries(raw)
    .map(([path, text]) => {
      const m = path.match(/\.\/([a-z-]+)\/([^/]+)\.md$/i);
      if (!m || m[1] !== lang) return null;
      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? m[2];
      const body = text.replace(/^#\s+.+\n+/, '');
      return { slug: m[2], title, body };
    })
    .filter((t): t is DocTopic => t !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The topics for a UI language; English, then Ukrainian, when a language has none. */
export function docsFor(language: string, raw: Record<string, string> = files): DocTopic[] {
  const lang = language.split('-')[0];
  for (const candidate of [lang, 'en', 'uk']) {
    const topics = parseDocs(raw, candidate);
    if (topics.length) return topics;
  }
  return [];
}

export interface DocMatch {
  topic: DocTopic;
  /** A short excerpt around the first match in the body, or '' when only the title matches */
  snippet: string;
}

/** Topics whose title or text contain every word of the query. Pure — tested directly. */
export function searchDocs(topics: DocTopic[], query: string): DocMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return topics.map((topic) => ({ topic, snippet: '' }));
  const plain = (md: string) => md.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`|>_[\]()]/g, ' ').replace(/\s+/g, ' ');
  const out: DocMatch[] = [];
  for (const topic of topics) {
    const text = plain(topic.body);
    const hay = `${topic.title} ${text}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const at = text.toLowerCase().indexOf(words[0]);
    const snippet = at >= 0 ? `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + 100).trim()}…` : '';
    out.push({ topic, snippet });
  }
  return out;
}
