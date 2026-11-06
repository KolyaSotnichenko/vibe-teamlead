/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeUsage } from '../../../main/ai/usage/usage-ledger';
import { ProjectUsage } from '../ProjectUsage';
import { useSettingsStore } from '../../stores/settings-store';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values?.models ? `${key}:${values.models}` : key),
    i18n: { language: 'en' },
  }),
}));

const line = JSON.stringify({ at: '2026-11-05T10:00:00.000Z', agentType: 'coder', model: 'glm-5.3', billing: 'gateway', gateway: 'gw.example.com', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, specId: 'task-a' });
const usage = vi.fn();
const saveSettings = vi.fn(async () => ({ success: true }));

const open = async () => {
  render(<ProjectUsage projectId="p" />);
  fireEvent.click(await screen.findByRole('button', { name: /usage.ariaLabel/ }));
};

beforeEach(() => {
  usage.mockReset();
  saveSettings.mockClear();
  useSettingsStore.setState((state) => ({ settings: { ...state.settings, gatewayModelPrices: undefined } }));
  Object.assign(window, { electronAPI: { usage: { get: usage }, saveSettings } });
});
afterEach(cleanup);

describe('ProjectUsage through a gateway', () => {
  it('says a model has no price, and invents no dollars', async () => {
    usage.mockResolvedValue({ success: true, data: summarizeUsage(line) });
    await open();
    expect(await screen.findByText('usage.noPrice')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('usage.gatewayUnpriced:glm-5.3');
  });

  it('shows the cost by kind of token and by task once the model has a price', async () => {
    usage.mockResolvedValue({ success: true, data: summarizeUsage(line, { 'glm-5.3': { input: 1, output: 4, cacheRead: 0.1 } }) });
    await open();
    expect(await screen.findByText('usage.billByKind')).toBeInTheDocument();
    expect(screen.getByText('task-a')).toBeInTheDocument();
    expect(screen.getAllByText('$5.10').length).toBeGreaterThan(0);
  });

  it('warns when a saved price looks swapped', async () => {
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, gatewayModelPrices: { 'glm-5.3': { input: 1.4, output: 0.26, cacheRead: 4.4 } } } }));
    usage.mockResolvedValue({ success: true, data: summarizeUsage(line) });
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('usage.priceSwapped');
  });

  it('lists the fields in the order gateways do', async () => {
    usage.mockResolvedValue({ success: true, data: summarizeUsage(line) });
    await open();
    const fields = await screen.findAllByRole('spinbutton');
    expect(fields.map((field) => field.getAttribute('aria-label'))).toEqual(['glm-5.3: usage.kinds.input', 'glm-5.3: usage.kinds.cacheRead', 'glm-5.3: usage.kinds.output']);
  });

  it('saves the prices once all three are in, and asks for the totals again', async () => {
    usage.mockResolvedValue({ success: true, data: summarizeUsage(line) });
    await open();
    const field = (kind: string) => screen.getByLabelText(`glm-5.3: usage.kinds.${kind}`);
    fireEvent.change(field('input'), { target: { value: '1' } });
    fireEvent.blur(field('input'));
    expect(saveSettings).not.toHaveBeenCalled();
    fireEvent.change(field('output'), { target: { value: '4' } });
    fireEvent.change(field('cacheRead'), { target: { value: '0.1' } });
    fireEvent.blur(field('cacheRead'));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ gatewayModelPrices: { 'glm-5.3': [expect.objectContaining({ from: '', input: 1, output: 4, cacheRead: 0.1 })] } }));
    await waitFor(() => expect(usage.mock.calls.length).toBeGreaterThan(1));
  });
});
