import { describe, expect, it } from 'vitest';

import { b, code, esc, htmlText, i, link, pre, quote, raw, toPlain, truncateHtml, visibleLength } from '../format';

describe('telegram HTML format', () => {
  it('escapes hostile text so it stays inert', () => {
    expect(esc('<b>bold</b> & <a href=javascript:alert(1)>x</a> "q"')).toBe(
      '&lt;b&gt;bold&lt;/b&gt; &amp; &lt;a href=javascript:alert(1)&gt;x&lt;/a&gt; &quot;q&quot;',
    );
    expect(b('<i>x</i>')).toBe('<b>&lt;i&gt;x&lt;/i&gt;</b>');
    expect(i('a & b')).toBe('<i>a &amp; b</i>');
    expect(code('vibe-teamlead/001-x')).toBe('<code>vibe-teamlead/001-x</code>');
  });

  it('pre with a language, the language cleaned', () => {
    expect(pre('a < b')).toBe('<pre>a &lt; b</pre>');
    expect(pre('x', 'ts')).toBe('<pre><code class="language-ts">x</code></pre>');
    expect(pre('x', 'ts" onclick="y')).toBe('<pre><code class="language-tsonclicky">x</code></pre>');
  });

  it('links only http(s) URLs, escaped; anything else is just the text', () => {
    expect(link('https://github.com/a/b/compare/main...x?y=1&z="2"', 'Diff')).toBe(
      '<a href="https://github.com/a/b/compare/main...x?y=1&amp;z=&quot;2&quot;">Diff</a>',
    );
    expect(link('javascript:alert(1)', '<x>')).toBe('&lt;x&gt;');
    expect(link('ftp://host/file', 'f')).toBe('f');
  });

  it('quotes, expandable on request', () => {
    expect(quote('a & b')).toBe('<blockquote>a &amp; b</blockquote>');
    expect(quote('long', { expandable: true })).toBe('<blockquote expandable>long</blockquote>');
  });

  it('counts what Telegram counts: no tags, an entity as one character', () => {
    expect(visibleLength('<b>a&amp;b</b>')).toBe(3);
  });

  it('truncates at the limit without cutting a tag or an entity, closing open tags', () => {
    const html = `<b>${'x'.repeat(10)}</b> <blockquote expandable>${'&amp;'.repeat(20)}</blockquote>`;
    const cut = truncateHtml(html, 15);
    expect(visibleLength(cut)).toBeLessThanOrEqual(15);
    expect(cut.endsWith('…</blockquote>')).toBe(true);
    expect(cut).not.toMatch(/&a?m?p?$|&amp(?!;)/);
    expect(cut.split('<blockquote').length).toBe(cut.split('</blockquote>').length);
    expect(truncateHtml('<b>short</b>', 15)).toBe('<b>short</b>');
  });

  it('keeps a long message under 4096 and never splits a surrogate pair', () => {
    const cut = truncateHtml(`<i>${'😀'.repeat(3000)}</i>`, 4096);
    expect(visibleLength(cut)).toBeLessThanOrEqual(4096);
    expect(cut).toMatch(/😀…<\/i>$/);
  });

  it('plain text: tags stripped, entities unescaped', () => {
    expect(toPlain('<b>a &lt;b&gt; &amp; &quot;c&quot;</b> <a href="https://x">link</a>')).toBe('a <b> & "c" link');
  });

  it('an HTML translator escapes every value and trusts only raw()', () => {
    const t = (key: string, vars: Record<string, string | number> = {}) => `${key}:${Object.values(vars).join('|')}`;
    const h = htmlText(t);
    expect(h('k', { task: '<b>x</b>', count: 2, safe: raw('<i>y</i>') })).toBe('k:&lt;b&gt;x&lt;/b&gt;|2|<i>y</i>');
  });
});
