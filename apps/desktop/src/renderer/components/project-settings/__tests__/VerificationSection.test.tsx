/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '../../../../shared/types';
import { parseEnvLines, VerificationSection } from '../VerificationSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
afterEach(cleanup);

const settings = (over: Partial<ProjectSettings> = {}) => ({ model: 'x', memoryBackend: 'file', linearSync: false, ...over }) as ProjectSettings;

describe('parseEnvLines', () => {
  it('reads one variable per line and keeps = inside the value', () => {
    expect(parseEnvLines('DATABASE_URL=postgres://u:p@h/db?a=1\n\n  CI_FLAG = yes \n')).toEqual({ DATABASE_URL: 'postgres://u:p@h/db?a=1', CI_FLAG: 'yes' });
  });

  it('skips what is not a variable', () => {
    expect(parseEnvLines('# comment\nno equals\n=novalue\n1BAD=x')).toEqual({});
  });

  it("a variable can't reach Object's prototype", () => {
    const parsed = parseEnvLines('__proto__=x');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe('VerificationSection', () => {
  const field = (name: string) => screen.getByLabelText(name);

  it('is on unless switched off', () => {
    render(<VerificationSection settings={settings()} setSettings={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('shows no fields when off', () => {
    render(<VerificationSection settings={settings({ verifyEnabled: false })} setSettings={vi.fn()} />);
    expect(screen.queryByLabelText('settings:verification.commands')).not.toBeInTheDocument();
  });

  it('saves commands line by line, and blank means detect', () => {
    const setSettings = vi.fn();
    render(<VerificationSection settings={settings()} setSettings={setSettings} />);
    fireEvent.change(field('settings:verification.commands'), { target: { value: ' make test \n\n./ci.sh\n' } });
    fireEvent.blur(field('settings:verification.commands'));
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ verifyCommands: ['make test', './ci.sh'] }));
    fireEvent.change(field('settings:verification.commands'), { target: { value: '  \n' } });
    fireEvent.blur(field('settings:verification.commands'));
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ verifyCommands: undefined }));
  });

  it('saves variables', () => {
    const setSettings = vi.fn();
    render(<VerificationSection settings={settings()} setSettings={setSettings} />);
    fireEvent.change(field('settings:verification.env'), { target: { value: 'DATABASE_URL=postgres://x' } });
    fireEvent.blur(field('settings:verification.env'));
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ verifyEnv: { DATABASE_URL: 'postgres://x' } }));
  });
});
