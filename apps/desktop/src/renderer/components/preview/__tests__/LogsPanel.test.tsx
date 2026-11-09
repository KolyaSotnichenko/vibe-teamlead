/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key), i18n: { language: 'en' } }),
}));

import { LogsPanel } from '../LogsPanel';
import { MailPanel } from '../MailPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const API_LOG = 'Nest started\n[email] to=me@x.test subject=Verify: http://localhost:49834/verify-email?token=abc\nlistening on 3001\n';

describe('LogsPanel', () => {
  function setup() {
    const preview = {
      logs: vi.fn(async () => ({ success: true, data: [{ service: 'api', text: API_LOG }, { service: 'web', text: 'ready in 2s\n' }] })),
      navigate: vi.fn(async () => ({ success: true })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = { preview };
    render(<LogsPanel projectId="p1" />);
    return preview;
  }

  it("shows a service's log, finds a line, and opens a link from it in the preview", async () => {
    const preview = setup();
    expect(await screen.findByText(/Nest started/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('preview.logs.search'), { target: { value: 'verify' } });
    expect(screen.queryByText(/Nest started/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'http://localhost:49834/verify-email?token=abc' }));
    expect(preview.navigate).toHaveBeenCalledWith({ url: 'http://localhost:49834/verify-email?token=abc' });
    fireEvent.change(screen.getByLabelText('preview.logs.search'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'web' }));
    expect(screen.getByText(/ready in 2s/)).toBeInTheDocument();
  });
});

describe('MailPanel', () => {
  it('lists what the app sent and opens a link from a message in the preview', async () => {
    const preview = {
      mailList: vi.fn(async () => ({ success: true, data: [{ id: 'm1', from: 'no-reply@app.test', to: ['me@x.test'], subject: 'Verify your email', at: '2026-11-09T14:00:00Z', snippet: 'Click' }] })),
      mailGet: vi.fn(async () => ({ success: true, data: { id: 'm1', from: 'no-reply@app.test', to: ['me@x.test'], subject: 'Verify your email', at: '', text: 'Open the link.', links: ['http://localhost:4100/verify?token=abc'] } })),
      navigate: vi.fn(async () => ({ success: true })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = { preview };
    render(<MailPanel projectId="p1" mail="started" />);
    fireEvent.click(await screen.findByRole('button', { name: /Verify your email/ }));
    expect(await screen.findByText('Open the link.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'http://localhost:4100/verify?token=abc' }));
    expect(preview.navigate).toHaveBeenCalledWith({ url: 'http://localhost:4100/verify?token=abc' });
  });

  it('explains where mail goes when nothing catches it', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { preview: { mailList: vi.fn() } };
    render(<MailPanel projectId="p1" mail={undefined} />);
    expect(screen.getByText('preview.mail.none')).toBeInTheDocument();
  });
});
