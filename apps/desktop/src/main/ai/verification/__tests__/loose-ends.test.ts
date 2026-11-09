import { describe, expect, it } from 'vitest';

import { findLooseEnds, looseEndKey } from '../loose-ends';

const scan = (files: Record<string, string>) => findLooseEnds({ files: Object.keys(files), read: (p) => files[p] ?? null });

describe('findLooseEnds: placeholders left in the product', () => {
  it("finds roadmaply's home page, which said it was a placeholder through 23 tasks", () => {
    const found = scan({
      'apps/web/src/app/page.tsx': '<main>\n  <h1>Roadmaply</h1>\n  <p>\n    Placeholder home page — the app skeleton ships before any domain feature.\n  </p>\n</main>',
    });
    expect(found).toEqual([
      { file: 'apps/web/src/app/page.tsx', line: 4, text: 'Placeholder home page — the app skeleton ships before any domain feature.' },
    ]);
  });

  it('finds the usual phrases in UI files of any stack', () => {
    const found = scan({
      'src/pages/Billing.vue': '<template><p>Coming soon</p></template>',
      'src/routes/+page.svelte': '<p>Lorem ipsum dolor sit amet</p>',
      'app/views/home/index.html.erb': '<h2>This page is under construction</h2>',
      'web/templates/dashboard.html': '<div>Not implemented yet</div>',
      'src/screens/Stats.tsx': "return <Text>{'TODO: real chart'}</Text>;",
    });
    expect(found.map((f) => f.file)).toEqual([
      'app/views/home/index.html.erb',
      'src/pages/Billing.vue',
      'src/routes/+page.svelte',
      'src/screens/Stats.tsx',
      'web/templates/dashboard.html',
    ]);
  });

  it("doesn't flag input placeholders, tests, stories, generated or vendored code, or server code", () => {
    expect(
      scan({
        'src/Login.tsx': '<input placeholder="Email" />\n<Input placeholder={t("search")} />',
        'src/Login.test.tsx': '<p>Coming soon</p>',
        'src/Card.stories.tsx': '<p>Lorem ipsum</p>',
        'e2e/home.spec.ts': "expect(page.getByText('Coming soon'))",
        'node_modules/x/index.html': '<p>Coming soon</p>',
        'dist/index.html': '<p>Coming soon</p>',
        '.vibe-teamlead/specs/001/spec.md': 'Placeholder home page',
        'apps/api/src/users.service.ts': "throw new Error('Not implemented')",
        'README.md': 'Coming soon',
      }),
    ).toEqual([]);
  });

  it('keeps a long line short and the list bounded', () => {
    const long = scan({ 'src/A.tsx': `<p>Coming soon ${'x'.repeat(500)}</p>` })[0];
    expect(long.text.length).toBeLessThanOrEqual(160);
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`src/P${i}.tsx`, '<p>Coming soon</p>']));
    expect(scan(many)).toHaveLength(50);
  });

  it('keys a finding by file and text, so ignoring it survives the line moving', () => {
    expect(looseEndKey({ file: 'a.tsx', line: 3, text: 'Coming soon' })).toBe(looseEndKey({ file: 'a.tsx', line: 9, text: 'Coming soon' }));
  });
});
