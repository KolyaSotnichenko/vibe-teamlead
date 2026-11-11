/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { MemoryCard } from '../MemoryCard';

afterEach(cleanup);

const memory = {
  id: 'm1',
  type: 'gotcha',
  content: 'The apostrophe is U+02BC',
  tags: [],
  relatedFiles: [],
  source: 'observer_inferred',
  confidence: 0.7,
  createdAt: '2026-11-11T10:00:00Z',
  userVerified: true,
} as never;

describe('a memory card', () => {
  it('has no Verify: it changed nothing the agents see', () => {
    render(<MemoryCard memory={memory} onPin={vi.fn()} onDeprecate={vi.fn()} />);
    expect(screen.queryByText('memory.actions.verify')).toBeNull();
    expect(screen.queryByLabelText('memory.badges.verified')).toBeNull();
    expect(screen.getByText('memory.actions.deprecate')).toBeInTheDocument();
  });
});
