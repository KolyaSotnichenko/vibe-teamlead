/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { PreviewEnvReport } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: 'en' } }),
}));
const store = vi.hoisted(() => ({ updateProjectSettings: vi.fn(async () => true) }));
vi.mock('../../../stores/project-store', () => store);

import { EnvPanel } from '../EnvPanel';

const REPORT: PreviewEnvReport = {
  running: true,
  restartNeeded: false,
  databases: ['postgres'],
  mail: true,
  dockerUnavailable: false,
  services: [
    {
      service: 'api',
      dir: 'api',
      vars: [
        { name: 'AUTH_TEST_IDP_ENABLED', value: 'true', source: 'exampleDir' },
        { name: 'JWT_SECRET', value: 'dev-secret', source: 'exampleDir' },
        { name: 'STRIPE_KEY', value: '', source: 'exampleDir' },
        { name: 'REDIS_URL', value: '', source: 'blocked' },
        { name: 'APP_NAME', value: 'mine', source: 'serviceOverride', automatic: { value: 'acme', source: 'example' } },
      ],
    },
  ],
};

let report: PreviewEnvReport;
const api = { env: vi.fn(async () => ({ success: true, data: report })), restartServices: vi.fn(async () => ({ success: true })) };

beforeEach(() => {
  report = REPORT;
  (window as unknown as { electronAPI: unknown }).electronAPI = { preview: api };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = async () => {
  render(<EnvPanel projectId="p1" settings={{ previewServiceEnv: { api: { APP_NAME: 'mine' } } }} stage="ready" />);
  fireEvent.click(await screen.findByText(/preview\.env\.details/));
};

describe('EnvPanel', () => {
  it('says in plain words what was started and what may not work, outside services first', async () => {
    render(<EnvPanel projectId="p1" settings={{}} stage="ready" />);
    expect(await screen.findByText(/preview\.env\.ready/)).toBeInTheDocument();
    expect(screen.getByText(/preview\.env\.empty\{"count":2/)).toHaveTextContent('preview.env.feature.payments');
    expect(screen.getByText(/preview\.env\.outside/)).toHaveTextContent('preview.env.feature.payments');
  });

  it('says first when Docker is not running', async () => {
    report = { ...REPORT, dockerUnavailable: true };
    render(<EnvPanel projectId="p1" settings={{}} stage="ready" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('preview.env.docker');
    expect(screen.queryByText(/preview\.env\.ready/)).not.toBeInTheDocument();
  });

  it('lists each setting with its source in plain words, empty ones first and marked, secrets masked', async () => {
    await open();
    const names = screen.getAllByText(/^[A-Z_]+$/).map((el) => el.textContent);
    expect(names.slice(0, 2)).toEqual(['REDIS_URL', 'STRIPE_KEY']);
    expect(screen.getAllByText('preview.env.emptyMark')).toHaveLength(2);
    expect(screen.getAllByText('preview.env.source.exampleDir').length).toBeGreaterThan(0);
    expect(screen.queryByText('dev-secret')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /preview\.env\.reveal.*JWT_SECRET/ }));
    expect(screen.getByText('dev-secret')).toBeInTheDocument();
  });

  it("names the compose services the preview started, and each value's service", async () => {
    report = {
      ...REPORT,
      composeServices: ['rabbitmq', 'minio'],
      services: [{
        service: 'api',
        dir: 'api',
        vars: [
          { name: 'AMQP_URL', value: 'amqp://127.0.0.1:50001', source: 'service', service: 'rabbitmq' },
          { name: 'S3_ENDPOINT', value: '', source: 'blocked', service: 'minio' },
        ],
      }],
    };
    render(<EnvPanel projectId="p1" settings={{}} stage="ready" />);
    expect(await screen.findByText(/preview\.env\.ready/)).toHaveTextContent('preview.env.partService{\\"name\\":\\"rabbitmq\\"}');
    fireEvent.click(await screen.findByText(/preview\.env\.details/));
    expect(screen.getByText('preview.env.source.service{"service":"rabbitmq"}')).toBeInTheDocument();
    expect(screen.getByText('preview.env.source.serviceDown{"service":"minio"}')).toBeInTheDocument();
  });

  it('filters to empty values', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('preview.env.emptyOnly'));
    expect(screen.queryByText('AUTH_TEST_IDP_ENABLED')).not.toBeInTheDocument();
    expect(screen.getByText('STRIPE_KEY')).toBeInTheDocument();
  });

  it("saves a value for the service, warns before pointing at a real service, and goes back to the automatic value", async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /preview\.env\.edit.*REDIS_URL/ }));
    expect(screen.getByText('preview.env.realWarning')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/preview\.env\.value.*REDIS_URL/), { target: { value: 'redis://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'preview.env.save' }));
    await waitFor(() => expect(store.updateProjectSettings).toHaveBeenCalledWith('p1', { previewServiceEnv: { api: { APP_NAME: 'mine', REDIS_URL: 'redis://x' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'preview.env.useAutomatic' }));
    await waitFor(() => expect(store.updateProjectSettings).toHaveBeenCalledWith('p1', { previewServiceEnv: { api: {} } }));
  });

  it('adds a variable and applies with a restart', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('preview.env.addName'), { target: { value: 'VITE_AUTH_MODE' } });
    fireEvent.change(screen.getByLabelText('preview.env.addValue'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'preview.env.add' }));
    await waitFor(() => expect(store.updateProjectSettings).toHaveBeenCalledWith('p1', { previewServiceEnv: { api: { APP_NAME: 'mine', VITE_AUTH_MODE: 'test' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'preview.env.apply' }));
    await waitFor(() => expect(api.restartServices).toHaveBeenCalledWith('p1'));
  });
});
