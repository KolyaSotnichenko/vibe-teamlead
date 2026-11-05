import { describe, expect, it, vi } from 'vitest';

const { readSettingsFile } = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile }));

import { isLspEnabled } from '../lsp-setting';

describe('isLspEnabled', () => {
  it('is on unless the setting is explicitly false', () => {
    readSettingsFile.mockReturnValue({});
    expect(isLspEnabled()).toBe(true);
    readSettingsFile.mockReturnValue(undefined);
    expect(isLspEnabled()).toBe(true);
    readSettingsFile.mockReturnValue({ lspEnabled: false });
    expect(isLspEnabled()).toBe(false);
  });

  it('stays on when the settings file cannot be read', () => {
    readSettingsFile.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isLspEnabled()).toBe(true);
  });
});
