import { describe, expect, it } from 'vitest';

import { b, code, esc, Html, html, htmlText, i, joinHtml, link, pre, quote, sanitizeHtml, toPlain, truncateHtml, visibleLength } from '../format';

const s = (value: Html) => value.value;

describe('telegram HTML format', () => {
  it('escapes hostile text so it stays inert', () => {
    expect(esc('<b>bold</b> & <a href=javascript:alert(1)>x</a> "q"')).toBe(
      '&lt;b&gt;bold&lt;/b&gt; &amp; &lt;a href=javascript:alert(1)&gt;x&lt;/a&gt; &quot;q&quot;',
    );
    expect(s(b('<i>x</i>'))).toBe('<b>&lt;i&gt;x&lt;/i&gt;</b>');
    expect(s(i('a & b'))).toBe('<i>a &amp; b</i>');
    expect(s(code('vibe-teamlead/001-x'))).toBe('<code>vibe-teamlead/001-x</code>');
  });

  it('Html is made only by the helpers', () => {
    expect(() => new Html('<b>x</b>', Symbol('html'))).toThrow();
  });

  it('the html template escapes its values and keeps Html ones', () => {
    expect(s(html`<b>${'<x>'}</b> ${2} ${i('y')}`)).toBe('<b>&lt;x&gt;</b> 2 <i>y</i>');
    expect(s(joinHtml([b('a'), i('b')], '\n'))).toBe('<b>a</b>\n<i>b</i>');
  });

  it('pre with a language, the language cleaned', () => {
    expect(s(pre('a < b'))).toBe('<pre>a &lt; b</pre>');
    expect(s(pre('x', 'ts'))).toBe('<pre><code class="language-ts">x</code></pre>');
    expect(s(pre('x', 'ts" onclick="y'))).toBe('<pre><code class="language-tsonclicky">x</code></pre>');
  });

  it('links only http(s) URLs, escaped; anything else is just the text', () => {
    expect(s(link('https://github.com/a/b/compare/main...x?y=1&z=2', 'Diff'))).toBe('<a href="https://github.com/a/b/compare/main...x?y=1&amp;z=2">Diff</a>');
    expect(s(link('javascript:alert(1)', '<x>'))).toBe('&lt;x&gt;');
    expect(s(link('ftp://host/file', 'f'))).toBe('f');
  });

  it('quotes, expandable on request', () => {
    expect(s(quote('a & b'))).toBe('<blockquote>a &amp; b</blockquote>');
    expect(s(quote('long', { expandable: true }))).toBe('<blockquote expandable>long</blockquote>');
  });

  it('sanitizeHtml keeps supported tags only; unknown tags, other attributes and stray markup become text', () => {
    expect(s(sanitizeHtml('<b>a</b> <script>x</script> <a href="https://x.dev">l</a>'))).toBe('<b>a</b> &lt;script&gt;x&lt;/script&gt; <a href="https://x.dev">l</a>');
    expect(s(sanitizeHtml("<a href='https://x'>l</a>"))).toBe('&lt;a href=&#39;https://x&#39;&gt;l&lt;/a&gt;'.replace(/&#39;/g, "'"));
    expect(s(sanitizeHtml('<a href="javascript:alert(1)">l</a>'))).toBe('l');
    expect(s(sanitizeHtml('<b onclick="x">a</b>'))).toBe('&lt;b onclick=&quot;x&quot;&gt;a&lt;/b&gt;');
    expect(s(sanitizeHtml('<b><i>a</b>'))).toBe('<b><i>a&lt;/b&gt;</i></b>');
    expect(s(sanitizeHtml('<blockquote expandable>q</blockquote><pre><code class="language-ts">c</code></pre>'))).toBe(
      '<blockquote expandable>q</blockquote><pre><code class="language-ts">c</code></pre>',
    );
  });

  it('counts what Telegram counts: no tags, an entity as one character', () => {
    expect(visibleLength(html`<b>a${'&'}b</b>`)).toBe(3);
  });

  it('truncates at the limit without cutting a tag or an entity, closing open tags', () => {
    const value = html`<b>${'x'.repeat(10)}</b> <blockquote expandable>${'&'.repeat(20)}</blockquote>`;
    const cut = s(truncateHtml(value, 15));
    expect(visibleLength(cut)).toBeLessThanOrEqual(15);
    expect(cut.endsWith('…</blockquote>')).toBe(true);
    expect(cut).not.toMatch(/&a?m?p?…|&amp(?!;)/);
    expect(cut.split('<blockquote').length).toBe(cut.split('</blockquote>').length);
    expect(s(truncateHtml(b('short'), 15))).toBe('<b>short</b>');
  });

  it('keeps a long message under 4096 and never splits a surrogate pair', () => {
    const cut = s(truncateHtml(i('😀'.repeat(3000)), 4096));
    expect(visibleLength(cut)).toBeLessThanOrEqual(4096);
    expect(cut).toMatch(/😀…<\/i>$/);
  });

  it('plain text: tags stripped, entities unescaped', () => {
    expect(toPlain(html`<b>a ${'<b> & "c"'}</b> ${link('https://x', 'link')}`)).toBe('a <b> & "c" link');
  });

  it('an HTML translator escapes every value and keeps Html ones', () => {
    const t = (key: string, vars: Record<string, string | number> = {}) => `<b>${key}</b>:${Object.values(vars).join('|')}`;
    const h = htmlText(t);
    expect(s(h('k', { task: '<b>x</b>', count: 2, safe: i('y') }))).toBe('<b>k</b>:&lt;b&gt;x&lt;/b&gt;|2|<i>y</i>');
  });
});
