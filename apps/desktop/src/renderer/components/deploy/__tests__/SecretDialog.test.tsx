/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeploySetSecretResult } from '../../../../shared/types/deploy';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

import { SecretDialog } from '../SecretDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(result: DeploySetSecretResult | null | Error = { ok: true }, props: { initialName?: string } = {}) {
  const setSecret = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result ? { success: true, data: result } : { success: false, error: 'x' };
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { deploy: { setSecret } };
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = render(<SecretDialog open projectId="p1" initialName={props.initialName} onClose={onClose} onSaved={onSaved} />);
  const name = () => screen.getByLabelText('deploy:secretDialog.name') as HTMLInputElement;
  const value = () => screen.getByLabelText('deploy:secretDialog.value') as HTMLInputElement;
  const save = () => screen.getByRole('button', { name: 'deploy:secretDialog.save' });
  return { setSecret, onClose, onSaved, view, name, value, save };
}

describe('SecretDialog', () => {
  it('saves the name and the value through deploy:setSecret only, then forgets the value', async () => {
    const d = setup({ ok: true }, { initialName: 'CSRF_SECRET' });
    expect(d.name().value).toBe('CSRF_SECRET');
    expect(d.value().type).toBe('password');
    fireEvent.change(d.value(), { target: { value: 'hunter2' } });
    fireEvent.click(d.save());
    await waitFor(() => expect(d.onSaved).toHaveBeenCalledWith('CSRF_SECRET'));
    expect(d.setSecret).toHaveBeenCalledWith('p1', 'CSRF_SECRET', 'hunter2');
    expect(d.value().value).toBe('');
    expect(document.body.innerHTML).not.toContain('hunter2');
  });

  it('checks the name by GitHub\'s rules: save stays off and the rule is shown', () => {
    const d = setup();
    fireEvent.change(d.value(), { target: { value: 'v' } });
    for (const bad of ['GITHUB_TOKEN', 'lower', '1ABC', 'A-B', '']) {
      fireEvent.change(d.name(), { target: { value: bad } });
      expect(d.save()).toBeDisabled();
    }
    expect(screen.getByText('deploy:secretDialog.nameRule')).toBeInTheDocument();
    fireEvent.change(d.name(), { target: { value: 'NPM_TOKEN' } });
    expect(d.save()).toBeEnabled();
  });

  it('save stays off without a value', () => {
    const d = setup({ ok: true }, { initialName: 'API_KEY' });
    expect(d.save()).toBeDisabled();
  });

  it('a failure shows the words for its kind and keeps the dialog open', async () => {
    const d = setup({ ok: false, kind: 'permissions' }, { initialName: 'API_KEY' });
    fireEvent.change(d.value(), { target: { value: 'v' } });
    fireEvent.click(d.save());
    expect(await screen.findByRole('alert')).toHaveTextContent('deploy:env.errors.permissions');
    expect(d.onSaved).not.toHaveBeenCalled();
  });

  it('a failed request shows the generic error', async () => {
    const d = setup(new Error('boom'), { initialName: 'API_KEY' });
    fireEvent.change(d.value(), { target: { value: 'v' } });
    fireEvent.click(d.save());
    expect(await screen.findByRole('alert')).toHaveTextContent('deploy:env.errors.unknown');
  });

  it('closing drops the typed value', () => {
    const d = setup({ ok: true }, { initialName: 'API_KEY' });
    fireEvent.change(d.value(), { target: { value: 'typed' } });
    d.view.rerender(<SecretDialog open={false} projectId="p1" initialName="API_KEY" onClose={d.onClose} onSaved={d.onSaved} />);
    d.view.rerender(<SecretDialog open projectId="p1" initialName="API_KEY" onClose={d.onClose} onSaved={d.onSaved} />);
    expect(d.value().value).toBe('');
  });
});
