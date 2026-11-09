/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

import { QueueSettingsModal } from '../QueueSettingsModal';

afterEach(cleanup);

function show(currentMaxParallel = 1, currentAutoMerge = false, currentPreviewHold = false) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  render(<QueueSettingsModal open onOpenChange={onOpenChange} projectId="p" currentMaxParallel={currentMaxParallel} currentAutoMerge={currentAutoMerge} currentPreviewBeforeAutoMerge={currentPreviewHold} onSave={onSave} />);
  return { onSave, onOpenChange, input: screen.getByRole('spinbutton') };
}
const WARNING = 'tasks:queue.settings.parallelWarning';
const save = () => fireEvent.click(screen.getByRole('button', { name: 'common:buttons.save' }));

describe('QueueSettingsModal', () => {
  it('warns about conflicts only above one task', () => {
    const { input } = show(1);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByRole('alert')).toHaveTextContent(WARNING);
  });

  it('warns when the project already runs more than one', () => {
    show(3);
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it('refuses more than three', () => {
    const { input, onSave } = show(1);
    fireEvent.change(input, { target: { value: '4' } });
    save();
    expect(screen.getByText('tasks:queue.settings.maxValueError')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves the limit and the auto-merge switch, off unless turned on', () => {
    const { input, onSave } = show(1);
    fireEvent.change(input, { target: { value: '2' } });
    save();
    expect(onSave).toHaveBeenCalledWith(2, false, false);
  });

  it('turns auto-merge on', () => {
    const { onSave } = show(1);
    fireEvent.click(screen.getByRole('switch'));
    save();
    expect(onSave).toHaveBeenCalledWith(1, true, false);
  });

  it('offers "UI tasks wait for my preview" only while auto-merge is on, off by default', () => {
    const { onSave } = show(1, false);
    expect(screen.queryByText('tasks:queue.settings.previewHoldLabel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByText('tasks:queue.settings.previewHoldLabel')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('switch')[1]);
    save();
    expect(onSave).toHaveBeenCalledWith(1, true, true);
  });

  it('keeps the preview switch as saved, and drops it when auto-merge goes off', () => {
    const { onSave } = show(1, true, true);
    expect(screen.getAllByRole('switch')[1]).toBeChecked();
    fireEvent.click(screen.getAllByRole('switch')[0]);
    save();
    expect(onSave).toHaveBeenCalledWith(1, false, false);
  });
});
