/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CloudDiagramsSetting } from '../CloudDiagramsSetting';
import type { AppSettings, CloudToolsState } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const tools = vi.fn<() => Promise<{ success: boolean; data?: CloudToolsState }>>();
const hints = { uv: 'brew install uv', graphviz: 'brew install graphviz', git: 'brew install git', terraform: 'brew install opentofu' };

beforeEach(() => {
  tools.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { cloudArchitecture: { tools } };
});

describe('CloudDiagramsSetting', () => {
  it('is on by default and turns off', () => {
    tools.mockResolvedValue({ success: true, data: { ready: true, drawFromCode: true, missing: [], hints } });
    const onChange = vi.fn();
    render(<CloudDiagramsSetting settings={{} as AppSettings} onSettingsChange={onChange} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ cloudDiagramsEnabled: false });
  });

  it("says what's missing with an install line for each, when on", async () => {
    tools.mockResolvedValue({ success: true, data: { ready: false, drawFromCode: false, missing: ['graphviz', 'terraform'], hints } });
    render(<CloudDiagramsSetting settings={{} as AppSettings} onSettingsChange={vi.fn()} />);
    expect(await screen.findByText('cloud:settings.notReady')).toBeInTheDocument();
    expect(screen.getByText('brew install graphviz')).toBeInTheDocument();
    expect(screen.getByText('brew install opentofu')).toBeInTheDocument();
    expect(screen.queryByText('brew install uv')).not.toBeInTheDocument();
  });

  it('says it is ready', async () => {
    tools.mockResolvedValue({ success: true, data: { ready: true, drawFromCode: true, missing: [], hints } });
    render(<CloudDiagramsSetting settings={{} as AppSettings} onSettingsChange={vi.fn()} />);
    expect(await screen.findByText('cloud:settings.ready')).toBeInTheDocument();
  });

  it("doesn't check the tools when off", () => {
    render(<CloudDiagramsSetting settings={{ cloudDiagramsEnabled: false } as AppSettings} onSettingsChange={vi.fn()} />);
    expect(tools).not.toHaveBeenCalled();
  });
});
