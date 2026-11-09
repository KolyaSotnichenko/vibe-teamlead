/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));
const dialog = vi.fn();
vi.mock('../../brief-import', () => ({
  BriefImportDialog: (props: { open: boolean; initialText?: string }) => {
    dialog(props);
    return props.open ? <div role="dialog">{props.initialText}</div> : null;
  },
}));

import { ApplyDesignSystem } from '../ApplyDesignSystem';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(result: unknown) {
  const redesignBrief = vi.fn(async () => result);
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: { redesignBrief } };
  render(<ApplyDesignSystem projectId="p1" />);
  return { redesignBrief };
}

describe('ApplyDesignSystem', () => {
  it('checks the whole UI, says what it found, and opens the spec import with the redesign brief to read first', async () => {
    const { redesignBrief } = setup({ success: true, data: { brief: '# Redesign: bring the existing UI…', findings: 37, files: 12 } });
    fireEvent.click(screen.getByRole('button', { name: 'context.design.apply.run' }));
    expect(redesignBrief).toHaveBeenCalledWith('p1');
    expect(await screen.findByRole('dialog')).toHaveTextContent('# Redesign: bring the existing UI…');
    expect(screen.getByText('context.design.apply.found {"findings":37,"files":12}')).toBeInTheDocument();
  });

  it('says why it could not', async () => {
    setup({ success: false, error: 'The project has no design system yet.' });
    fireEvent.click(screen.getByRole('button', { name: 'context.design.apply.run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The project has no design system yet.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
