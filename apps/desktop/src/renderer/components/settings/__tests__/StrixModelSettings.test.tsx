/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../../shared/i18n';
import type { AppSettings } from '../../../../shared/types';
import { StrixModelSettings, withStrixProvider } from '../StrixModelSettings';

function mockApi(status: Record<string, Record<string, boolean>> = {}) {
  const api = {
    getSecretsStatus: vi.fn(async () => status),
    saveSecret: vi.fn(async (provider: string, name: string) => ({ success: true, data: { [provider]: { [name]: true } } })),
    clearSecret: vi.fn(async (provider: string) => ({ success: true, data: { [provider]: {} } })),
    pickCredentialsFile: vi.fn(async () => '/keys/sa.json'),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { strix: api };
  return api;
}

const base = { securityQaEnabled: true } as AppSettings;

describe('Settings → Security QA → Model for Strix', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to the agents: no model or key fields, the subscription note and the recommendation', async () => {
    mockApi();
    render(<StrixModelSettings settings={base} onSettingsChange={vi.fn()} />);
    expect(screen.getByText('Model for Strix')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.getByText(/A Claude subscription can't run Strix/)).toBeInTheDocument();
    expect(screen.getByText(/GLM-5.3 through OpenRouter or Vercel AI Gateway/)).toBeInTheDocument();
  });

  it('choosing a provider prefills its example model', () => {
    expect(withStrixProvider(base, 'openrouter')).toMatchObject({ securityQaProvider: 'openrouter', securityQaModel: 'openrouter/z-ai/glm-5.3' });
    expect(withStrixProvider(base, 'azure').securityQaModel).toBe('');
  });

  it('saves a key write-only: the field is cleared and only "saved" is shown', async () => {
    const api = mockApi();
    render(<StrixModelSettings settings={withStrixProvider(base, 'openrouter')} onSettingsChange={vi.fn()} />);
    expect(screen.getByLabelText('Model')).toHaveValue('openrouter/z-ai/glm-5.3');
    const key = screen.getByLabelText('API key');
    expect(key).toHaveAttribute('type', 'password');
    fireEvent.change(key, { target: { value: 'sk-or-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSecret).toHaveBeenCalledWith('openrouter', 'apiKey', 'sk-or-1'));
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.clearSecret).toHaveBeenCalledWith('openrouter', 'apiKey'));
  });

  it("shows only the provider's own fields, with its notes", async () => {
    mockApi({ azure: { azureApiKey: true } });
    const { rerender } = render(<StrixModelSettings settings={withStrixProvider(base, 'azure')} onSettingsChange={vi.fn()} />);
    expect(screen.getByLabelText('Endpoint URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API version')).toBeInTheDocument();
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    expect(screen.getByText(/cyber access program/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Region')).not.toBeInTheDocument();

    rerender(<StrixModelSettings settings={{ ...withStrixProvider(base, 'bedrock'), securityQaProviderFields: { awsAuth: 'profile' } }} onSettingsChange={vi.fn()} />);
    expect(screen.getByLabelText('AWS profile')).toBeInTheDocument();
    expect(screen.getByLabelText('Region')).toBeInTheDocument();
    expect(screen.queryByLabelText('Secret access key')).not.toBeInTheDocument();

    rerender(<StrixModelSettings settings={withStrixProvider(base, 'local')} onSettingsChange={vi.fn()} />);
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API key (optional)')).toBeInTheDocument();
    expect(screen.getByText(/under about 30B/)).toBeInTheDocument();

    rerender(<StrixModelSettings settings={withStrixProvider(base, 'chatgpt')} onSettingsChange={vi.fn()} />);
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.getByText(/strix auth login chatgpt/)).toBeInTheDocument();
  });

  it('vertex: project, location and a picked credentials file', async () => {
    mockApi();
    const onChange = vi.fn();
    render(<StrixModelSettings settings={withStrixProvider(base, 'vertex')} onSettingsChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ securityQaProviderFields: { vertexProject: 'p1' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ securityQaProviderFields: { vertexCredentialsFile: '/keys/sa.json' } })),
    );
  });
});
