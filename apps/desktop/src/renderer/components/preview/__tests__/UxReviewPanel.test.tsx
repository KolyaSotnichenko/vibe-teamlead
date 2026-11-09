/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UxReviewResult } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));
const createTask = vi.fn(async () => ({ id: 't1' }));
vi.mock('../../../stores/task-store', () => ({ createTask: (...a: unknown[]) => createTask(...(a as [])) }));

import { UxReviewPanel, findingTask, findingsTask } from '../UxReviewPanel';

const REVIEW: UxReviewResult = {
  summary: 'The home page is a placeholder.',
  pages: ['/', '/login'],
  at: '2026-11-09T12:00:00.000Z',
  findings: [
    { page: '/login', width: 375, severity: 'note', problem: 'Heading wraps', expected: 'Shorter heading' },
    { page: '/', width: 1280, severity: 'blocks', problem: 'The home page is a placeholder', expected: 'A landing page or a redirect', file: 'apps/web/src/app/page.tsx' },
  ],
};

function setup(last: UxReviewResult | null = null, run: ReturnType<typeof vi.fn> = vi.fn(async () => ({ success: true, data: REVIEW }))) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    preview: { lastUxReview: vi.fn(async () => ({ success: true, data: last })), uxReview: run, cancelUxReview: vi.fn(async () => ({ success: true })) },
  };
  render(<UxReviewPanel projectId="p1" ready />);
  return { run };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UxReviewPanel', () => {
  it('runs a review, then lists what blocks first, with page, width and file', async () => {
    const { run } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'preview.ux.run' }));
    expect(run).toHaveBeenCalledWith('p1');
    const items = await screen.findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('The home page is a placeholder');
    expect(items[0]).toHaveTextContent('apps/web/src/app/page.tsx');
    expect(items[1]).toHaveTextContent('Heading wraps');
    expect(screen.getByText('The home page is a placeholder.')).toBeInTheDocument();
  });

  it('shows the last review when it opens', async () => {
    setup(REVIEW);
    expect(await screen.findByText('The home page is a placeholder.')).toBeInTheDocument();
  });

  it('says why a review failed', async () => {
    setup(null, vi.fn(async () => ({ success: false, error: 'The preview is not running.' })));
    fireEvent.click(await screen.findByRole('button', { name: 'preview.ux.run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The preview is not running.');
  });

  it('makes a task from one finding, or one task from everything that blocks', async () => {
    setup(REVIEW);
    await screen.findByText('The home page is a placeholder.');
    fireEvent.click(screen.getAllByRole('button', { name: 'preview.ux.createTask' })[0]);
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'preview.ux.createAll {"count":1}' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    const [, title, description] = createTask.mock.calls[1] as unknown as [string, string, string];
    expect(title).toMatch(/UX/);
    expect(description).toContain('AC-1');
    expect(description).not.toContain('Heading wraps');
  });

  it('can stop a running review', async () => {
    let finish: (value: unknown) => void = () => {};
    const run = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    setup(null, run as never);
    fireEvent.click(await screen.findByRole('button', { name: 'preview.ux.run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'preview.ux.stop' }));
    expect(window.electronAPI.preview.cancelUxReview).toHaveBeenCalled();
    finish({ success: false, error: 'stopped' });
  });
});

describe('task text', () => {
  it('names the page, width, file and the check, as an acceptance criterion', () => {
    const { title, description } = findingTask(REVIEW.findings[1]);
    expect(title).toBe('UX: The home page is a placeholder (/)');
    expect(description).toContain('`/` at 1280 px');
    expect(description).toContain('apps/web/src/app/page.tsx');
    expect(description).toMatch(/AC-1: .*A landing page or a redirect/);
    expect(findingsTask(REVIEW.findings).description).toMatch(/AC-2: /);
  });
});
