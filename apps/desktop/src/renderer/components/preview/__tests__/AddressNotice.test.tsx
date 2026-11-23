/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PreviewAddressIssue, PreviewService } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));
const createTask = vi.fn(async () => ({ id: 't1' }));
vi.mock('../../../stores/task-store', () => ({ createTask: (...a: unknown[]) => createTask(...(a as [])) }));

import { AddressNotice, addressTask } from '../AddressNotice';

const SERVICES: PreviewService[] = [
  { name: 'web', dir: 'apps/web', command: 'pnpm run dev --port {port}', page: true },
  { name: 'api', dir: 'apps/api', command: 'pnpm run dev' },
];
const FOUND: PreviewAddressIssue = { service: 'api', from: 'web', file: 'apps/web/vite.config.ts', line: 3, address: 'http://localhost:3000', ownPort: 3000, previewPort: 55819 };
const PROBED: PreviewAddressIssue = { service: 'api', unreachable: { path: '/rpc', result: '502' } };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('addressTask: the fix as a task, without a model call', () => {
  it("names the example settings of the folder the issue came from, also for services the owner never saved", () => {
    const { description } = addressTask({ ...FOUND, fromDir: 'frontend' }, []);
    expect(description).toContain('`frontend/.env.example`');
  });

  it('asks to read the address from a variable with the current value as default, and to add it to .env.example', () => {
    const { title, description } = addressTask(FOUND, SERVICES);
    expect(title).toBe('Read the api address in apps/web/vite.config.ts from API_URL');
    expect(description).toContain('`apps/web/vite.config.ts` line 3');
    expect(description).toContain('`http://localhost:3000`');
    expect(description).toContain('55819');
    expect(description).toContain('process.env.API_URL');
    expect(description).toContain('`apps/web/.env.example`');
    expect(description).toContain('API_URL=http://localhost:3000');
    expect(description).toMatch(/- AC-1: .*API_URL/);
    expect(description).toMatch(/- AC-2: .*apps\/web\/\.env\.example/);
    expect(description).toMatch(/- AC-3: /);
  });

  it('for a failed request alone, asks to find where the page names the backend', () => {
    const { title, description } = addressTask(PROBED, SERVICES);
    expect(title).toBe("Let the preview's page reach api");
    expect(description).toContain('`/rpc`');
    expect(description).toContain('502');
    expect(description).toContain('`.env.example`');
    expect(description).toMatch(/- AC-1: /);
  });

  it('keeps a variable name a shell can use, and backticks out of file names', () => {
    const { title, description } = addressTask({ ...FOUND, service: 'my-api', file: 'apps/web/`x`.config.ts' }, SERVICES);
    expect(title).toContain('MY_API_URL');
    expect(description).not.toContain('`x`');
  });
});

describe('AddressNotice', () => {
  it('says which file sends where and why, and creates the fix task on Planning', async () => {
    render(<AddressNotice projectId="p1" services={SERVICES} issues={[FOUND]} />);
    expect(screen.getByRole('status')).toHaveTextContent('preview.address.hardcoded');
    expect(screen.getByRole('status')).toHaveTextContent('apps/web/vite.config.ts');
    expect(screen.getByRole('status')).toHaveTextContent('55819');
    fireEvent.click(screen.getByRole('button', { name: 'preview.address.createTask' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    const [projectId, title, , metadata] = createTask.mock.calls[0] as unknown as [string, string, string, unknown];
    expect(projectId).toBe('p1');
    expect(title).toContain('API_URL');
    expect(metadata).toBeUndefined();
    expect(await screen.findByText('preview.address.taskCreated')).toBeInTheDocument();
  });

  it("says the page can't reach a service when only the request failed", () => {
    render(<AddressNotice projectId="p1" services={SERVICES} issues={[PROBED]} />);
    expect(screen.getByRole('status')).toHaveTextContent('preview.address.unreachable');
    expect(screen.getByRole('status')).toHaveTextContent('/rpc');
  });

  it('shows nothing without issues', () => {
    const { container } = render(<AddressNotice projectId="p1" services={SERVICES} issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
