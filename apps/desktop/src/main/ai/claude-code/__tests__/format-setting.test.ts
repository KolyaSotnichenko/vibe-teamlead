import { describe, expect, it, vi } from 'vitest';

const { readSettingsFile } = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile }));

import { isFormatOnEditEnabled } from '../format-setting';

describe('isFormatOnEditEnabled', () => {
  it('is on unless the setting is explicitly false', () => {
    readSettingsFile.mockReturnValue({});
    expect(isFormatOnEditEnabled()).toBe(true);
    readSettingsFile.mockReturnValue(undefined);
    expect(isFormatOnEditEnabled()).toBe(true);
    readSettingsFile.mockReturnValue({ formatOnEdit: true });
    expect(isFormatOnEditEnabled()).toBe(true);
    readSettingsFile.mockReturnValue({ formatOnEdit: false });
    expect(isFormatOnEditEnabled()).toBe(false);
  });

  it('stays on when the settings file cannot be read', () => {
    readSettingsFile.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isFormatOnEditEnabled()).toBe(true);
  });
});
