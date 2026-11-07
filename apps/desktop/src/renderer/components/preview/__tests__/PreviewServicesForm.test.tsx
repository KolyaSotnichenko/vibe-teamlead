/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
afterEach(cleanup);

import type { PreviewService } from '../../../../shared/types';
import { PreviewServicesForm, servicesProblem } from '../PreviewServicesForm';

const PROPOSED: PreviewService[] = [
  { name: 'api', dir: 'apps/api', command: 'pnpm run start:dev' },
  { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true },
];

describe('the preview services form', () => {
  it('saves the proposals unchanged on confirm', () => {
    const onSave = vi.fn();
    render(<PreviewServicesForm initial={PROPOSED} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /preview.services.save/ }));
    expect(onSave).toHaveBeenCalledWith(PROPOSED);
  });

  it('refuses no page, two pages and a bad name', () => {
    expect(servicesProblem([{ ...PROPOSED[0] }])).toBe('page');
    expect(servicesProblem(PROPOSED.map((s) => ({ ...s, page: true })))).toBe('page');
    expect(servicesProblem([{ ...PROPOSED[0], name: 'my api' }, PROPOSED[1]])).toBe('name');
    expect(servicesProblem([{ ...PROPOSED[0], command: ' ' }, PROPOSED[1]])).toBe('command');
    expect(servicesProblem(PROPOSED)).toBeNull();
  });

  it('shows the problem instead of saving', () => {
    const onSave = vi.fn();
    render(<PreviewServicesForm initial={[PROPOSED[0]]} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /preview.services.save/ }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('preview.services.problem.page');
  });
});
