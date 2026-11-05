import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readSettingsFile } = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile }));

import { readArchitectMode } from '../architect-setting';

describe('readArchitectMode', () => {
  beforeEach(() => readSettingsFile.mockReset());

  it('returns the saved mode', () => {
    for (const mode of ['always', 'complex', 'never']) {
      readSettingsFile.mockReturnValue({ architectMode: mode });
      expect(readArchitectMode()).toBe(mode);
    }
  });

  it('falls back to "complex" when the setting is missing or invalid', () => {
    readSettingsFile.mockReturnValue({});
    expect(readArchitectMode()).toBe('complex');
    readSettingsFile.mockReturnValue({ architectMode: 'sometimes' });
    expect(readArchitectMode()).toBe('complex');
    readSettingsFile.mockReturnValue(undefined);
    expect(readArchitectMode()).toBe('complex');
  });
});
