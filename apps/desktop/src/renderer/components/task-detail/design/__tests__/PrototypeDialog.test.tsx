/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o?.frame ? `${key}:${o.frame}` : key) }) }));

import { PrototypeDialog } from '../DesignCanvas';

afterEach(cleanup);

const frames = [
  { file: 'screens/table.html', title: 'Table · desktop', kind: 'screen' as const, width: 1280, height: 900, x: 0, y: 0, start: true },
  { file: 'screens/table-states.html', title: 'States · desktop', kind: 'screen' as const, width: 1280, height: 900, x: 1360, y: 0 },
];

describe('the prototype', () => {
  it('follows the pages clicked through and goes back along them', () => {
    const onChange = vi.fn();
    render(<PrototypeDialog prototype={{ frame: frames[0], width: 1280 }} onChange={onChange} urlFor={(f) => `vt-design://task/t/${f}`} frames={frames} />);
    expect(screen.getByRole('button', { name: 'design.back' })).toBeDisabled();
    const iframe = screen.getByTitle('Table · desktop') as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'vt-design:links', page: '/t/screens/table-states.html', links: [] }, source: iframe.contentWindow }));
    });
    expect(screen.getByText('design.prototypeTitle:States · desktop')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'design.back' }));
    expect(onChange).toHaveBeenCalledWith({ frame: frames[0], width: 1280 });
  });

  it('keeps the page it is on when the width changes', () => {
    const onChange = vi.fn();
    render(<PrototypeDialog prototype={{ frame: frames[0], width: 1280 }} onChange={onChange} urlFor={(f) => f} frames={frames} />);
    fireEvent.click(screen.getByRole('radio', { name: '390' }));
    expect(onChange).toHaveBeenCalledWith({ frame: frames[0], width: 390 });
  });
});
