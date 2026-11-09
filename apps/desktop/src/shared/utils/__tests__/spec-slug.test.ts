import { describe, expect, it } from 'vitest';

import { specSlug } from '../spec-slug';

describe('specSlug: the name part of a task folder and branch', () => {
  it('keeps the slug English titles always had', () => {
    expect(specSlug('Replace the placeholder in apps/web/src/app/page.tsx')).toBe('replace-the-placeholder-in-apps-web-src-app-page-t');
  });

  it('transliterates a Ukrainian or Russian title instead of leaving it empty (task "028-")', () => {
    expect(specSlug('Сторінка входу — додати посилання на реєстрацію')).toBe('storinka-vkhodu-dodaty-posylannya-na-reyestratsiyu');
    expect(specSlug('Убрать переключатель темы')).toBe('ubrat-pereklyuchatel-temy');
  });

  it('drops accents, and falls back to "task" when nothing is left', () => {
    expect(specSlug('Café crème')).toBe('cafe-creme');
    expect(specSlug('日本語のタイトル')).toBe('task');
    expect(specSlug('   ')).toBe('task');
  });
});
