/** Mermaid source as agents tend to write it, without a ```mermaid fence around it. */
export function cleanMermaidSource(source: string): string {
  const fenced = source.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : source).trim();
}

/** First lines of a Mermaid error, for showing next to the diagram. */
export function mermaidErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'object' && error && 'str' in error ? String((error as { str: unknown }).str) : String(error);
  return raw.split('\n').slice(0, 4).join('\n').slice(0, 600);
}
