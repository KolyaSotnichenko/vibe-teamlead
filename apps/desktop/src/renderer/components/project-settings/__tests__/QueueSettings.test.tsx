/**
 * @vitest-environment jsdom
 */
/**
 * Settings → Project → Queue: the limit, auto-merge and the preview hold, edited in the
 * project's settings (they save with the section, like the others).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectSettings } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

import { QueueSettings } from '../QueueSettings';

afterEach(cleanup);

const WARNING = 'tasks:queue.settings.parallelWarning';
const AUTO_MERGE = { name: 'tasks:queue.settings.autoMergeLabel' };
const PREVIEW_HOLD = { name: 'tasks:queue.settings.previewHoldLabel' };
const PREVIEW_FIX = { name: 'tasks:queue.settings.previewFixLabel' };

function show(initial: Partial<ProjectSettings> = {}) {
  const latest: { settings: ProjectSettings } = { settings: initial as ProjectSettings };
  function Harness() {
    const [settings, setSettings] = useState<ProjectSettings>(initial as ProjectSettings);
    latest.settings = settings;
    return <QueueSettings settings={settings} setSettings={setSettings} />;
  }
  render(<Harness />);
  return { latest, input: screen.getByRole('spinbutton') };
}

describe('QueueSettings', () => {
  it('shows the saved values, the default limit when none is saved', () => {
    const { input } = show();
    expect(input).toHaveValue(1);
    expect(screen.getByRole('switch', AUTO_MERGE)).not.toBeChecked();
    cleanup();
    show({ maxParallelTasks: 2, autoMerge: true, previewBeforeAutoMerge: true });
    expect(screen.getByRole('spinbutton')).toHaveValue(2);
    expect(screen.getByRole('switch', AUTO_MERGE)).toBeChecked();
    expect(screen.getByRole('switch', PREVIEW_HOLD)).toBeChecked();
  });

  it("shows the project's pipeline for tasks: Auto when none is saved, the saved one otherwise", () => {
    show();
    expect(screen.getByText('tasks:queue.settings.defaultPipelineLabel')).toBeInTheDocument();
    expect(screen.getByText('tasks:queue.settings.defaultPipelineHint')).toBeInTheDocument();
    // The line under the field says what the shown pipeline runs
    expect(screen.getByText('pipeline.optionHelp.auto')).toBeInTheDocument();
    cleanup();
    show({ defaultPipeline: 'single' });
    expect(screen.getByText('pipeline.optionHelp.single')).toBeInTheDocument();
    expect(screen.queryByText('pipeline.optionHelp.auto')).not.toBeInTheDocument();
  });

  it('warns about conflicts only above one task', () => {
    const { input, latest } = show();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByRole('alert')).toHaveTextContent(WARNING);
    expect(latest.settings.maxParallelTasks).toBe(2);
  });

  it('says what is wrong with a limit out of range', () => {
    const { input } = show();
    fireEvent.change(input, { target: { value: '4' } });
    expect(screen.getByText('tasks:queue.settings.maxValueError')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('tasks:queue.settings.minValueError')).toBeInTheDocument();
  });

  it('offers "UI tasks wait for my preview" only while auto-merge is on, off by default', () => {
    const { latest } = show();
    expect(screen.queryByText('tasks:queue.settings.previewHoldLabel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', AUTO_MERGE));
    expect(latest.settings.autoMerge).toBe(true);
    expect(screen.getByRole('switch', PREVIEW_HOLD)).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch', PREVIEW_HOLD));
    expect(latest.settings.previewBeforeAutoMerge).toBe(true);
  });

  it('drops the preview hold when auto-merge goes off', () => {
    const { latest } = show({ autoMerge: true, previewBeforeAutoMerge: true });
    fireEvent.click(screen.getByRole('switch', AUTO_MERGE));
    expect(latest.settings).toMatchObject({ autoMerge: false, previewBeforeAutoMerge: false });
    expect(screen.queryByText('tasks:queue.settings.previewHoldLabel')).not.toBeInTheDocument();
  });

  it('lets a failed preview start ask the agent by itself, on by default and whatever auto-merge says', () => {
    const { latest } = show();
    expect(screen.getByText('tasks:queue.settings.previewFixHint')).toBeInTheDocument();
    const fix = screen.getByRole('switch', PREVIEW_FIX);
    expect(fix).toBeChecked();
    fireEvent.click(fix);
    expect(latest.settings.previewFixAutomatically).toBe(false);
    expect(screen.getByRole('switch', PREVIEW_FIX)).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch', PREVIEW_FIX));
    expect(latest.settings.previewFixAutomatically).toBe(true);
    // Auto-merge doesn't take it away
    fireEvent.click(screen.getByRole('switch', AUTO_MERGE));
    fireEvent.click(screen.getByRole('switch', AUTO_MERGE));
    expect(latest.settings.previewFixAutomatically).toBe(true);
  });

  it('shows the setting off when the project turned it off', () => {
    show({ previewFixAutomatically: false });
    expect(screen.getByRole('switch', PREVIEW_FIX)).not.toBeChecked();
  });
});
