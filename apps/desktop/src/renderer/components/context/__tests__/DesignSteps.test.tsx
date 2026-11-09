/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key), i18n: { language: 'en' } }),
}));

import { designFlow } from '../design-flow';
import { DesignSteps } from '../DesignSteps';

afterEach(cleanup);

const ref = (id: string, addedAt: string) => ({ id, addedAt, status: 'ready' }) as never;

describe('DesignSteps', () => {
  it('points at the design system when there is none yet', () => {
    render(<DesignSteps flow={designFlow({ exists: false, references: [], audit: undefined })} />);
    const current = screen.getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('context.design.flow.kicker.startHere');
    expect(current).toHaveTextContent('context.design.flow.system.none');
    expect(screen.getByText('context.design.flow.apply.statusWaiting')).toBeInTheDocument();
  });

  it('marks the references as changed and the system as needing an update when references came after it', () => {
    const meta = { writtenAt: '2026-11-03T10:00:00Z', how: 'extract' as const, referenceIds: ['a'] };
    render(
      <DesignSteps
        meta={meta}
        flow={designFlow({ exists: true, meta, references: [ref('a', '2026-11-01T00:00:00Z'), ref('b', '2026-11-05T00:00:00Z')], audit: { findings: 0, files: 0, uiFiles: 169, top: [] } })}
      />,
    );
    expect(screen.getByText('context.design.flow.references.statusChanged')).toBeInTheDocument();
    const current = screen.getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('context.design.flow.system.statusStale');
    expect(within(current).getByText(/context.design.flow.system.extract/)).toBeInTheDocument();
  });

  it('points at applying the system when the code does not follow it, with how much differs', () => {
    render(<DesignSteps flow={designFlow({ exists: true, references: [], audit: { findings: 37, files: 12, uiFiles: 169, top: [] } })} />);
    const current = screen.getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('context.design.flow.apply.diff');
    expect(current).toHaveTextContent('context.design.flow.apply.places {"count":37}');
    expect(current).toHaveTextContent('context.design.flow.apply.inFiles {"count":12}');
  });
});
