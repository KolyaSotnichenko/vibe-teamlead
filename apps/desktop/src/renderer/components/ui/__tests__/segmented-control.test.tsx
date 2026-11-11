/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl } from '../segmented-control';

afterEach(cleanup);

const options = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
] as const;

describe('SegmentedControl', () => {
  it('shows every option as a radio in one labelled group, the current one checked', () => {
    render(<SegmentedControl label="Issue state" value="open" options={options} onChange={() => undefined} />);
    const group = screen.getByRole('radiogroup', { name: 'Issue state' });
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Open', 'Closed', 'All']);
    expect(group).toContainElement(radios[0]);
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Closed' })).toHaveAttribute('aria-checked', 'false');
    // Only the checked option is in the tab order
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '-1');
  });

  it('picks an option on click, and not the one already picked', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Issue state" value="open" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Closed' }));
    expect(onChange).toHaveBeenCalledWith('closed');
    fireEvent.click(screen.getByRole('radio', { name: 'Open' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moves with the arrow keys, wrapping around', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Issue state" value="open" options={options} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Open' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('closed');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Open' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('all');
  });

  it('jumps to the first and last option with Home and End', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Issue state" value="closed" options={options} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Closed' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('all');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Closed' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('open');
  });

  it('keeps the first option tabbable when the value is none of the options', () => {
    render(<SegmentedControl label="Issue state" value={'other' as 'open'} options={options} onChange={() => undefined} />);
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });
});
