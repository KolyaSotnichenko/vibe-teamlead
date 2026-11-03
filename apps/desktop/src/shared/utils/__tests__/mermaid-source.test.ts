import { describe, expect, it } from 'vitest';
import { cleanMermaidSource, mermaidErrorText } from '../mermaid-source';

describe('cleanMermaidSource', () => {
  it('drops a ```mermaid fence and surrounding text', () => {
    expect(cleanMermaidSource('Boot flow:\n```mermaid\nflowchart LR\n  a --> b\n```\n')).toBe('flowchart LR\n  a --> b');
    expect(cleanMermaidSource('```\nsequenceDiagram\n  A->>B: hi\n```')).toBe('sequenceDiagram\n  A->>B: hi');
  });

  it('leaves plain Mermaid alone', () => {
    expect(cleanMermaidSource('  flowchart TD\n  a --> b\n')).toBe('flowchart TD\n  a --> b');
  });
});

describe('mermaidErrorText', () => {
  it('keeps the first lines of the parser error', () => {
    const error = new Error('Parse error on line 2:\n...A[Next.js (web)]\n-----^\nExpecting SQE\nmore\nmore');
    expect(mermaidErrorText(error)).toBe('Parse error on line 2:\n...A[Next.js (web)]\n-----^\nExpecting SQE');
    expect(mermaidErrorText({ str: 'Lexical error' })).toBe('Lexical error');
  });
});
