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

const audit = {
  findings: 37,
  files: 12,
  uiFiles: 169,
  top: [
    { file: 'src/components/app-shell.tsx', count: 9, rules: ['off-palette-color', 'shadow'] },
    { file: 'src/components/ui/button.tsx', count: 6, rules: ['radius'] },
  ],
};

function setup(result: unknown, a: unknown = audit) {
  const redesignBrief = vi.fn(async () => result);
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: { redesignBrief } };
  render(<ApplyDesignSystem projectId="p1" audit={a as never} />);
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

  it('shows where the code differs, the files with the most, and what happens next', () => {
    setup({ success: true, data: {} });
    expect(screen.getByText('context.design.apply.diffTitle')).toBeInTheDocument();
    expect(screen.getByText('src/components/app-shell.tsx')).toBeInTheDocument();
    expect(screen.getByText(/9 · context.design.apply.rules.off-palette-color, context.design.apply.rules.shadow/)).toBeInTheDocument();
    expect(screen.getByText('context.design.apply.more {"count":10}')).toBeInTheDocument();
    expect(screen.getByText('context.design.apply.nextTitle')).toBeInTheDocument();
  });

  it('still offers a redesign when the code already follows the system', () => {
    setup({ success: true, data: {} }, { findings: 0, files: 0, uiFiles: 169, top: [] });
    expect(screen.getByText('context.design.apply.cleanTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'context.design.apply.run' })).toBeEnabled();
  });

  it('says why it could not', async () => {
    setup({ success: false, error: 'The project has no design system yet.' });
    fireEvent.click(screen.getByRole('button', { name: 'context.design.apply.run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The project has no design system yet.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
