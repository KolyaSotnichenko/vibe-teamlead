import { describe, expect, it } from 'vitest';

import { packagePickerOptions } from '../picker-options';

describe('packagePickerOptions', () => {
  it('one dialog for a zip or a folder when no kind is asked (macOS can show both)', () => {
    expect(packagePickerOptions()).toEqual({ properties: ['openFile', 'openDirectory'], filters: [{ name: 'Design package', extensions: ['zip'] }] });
  });

  // Windows and Linux show only a folder picker when asked for both
  it('a zip alone, or a folder alone', () => {
    expect(packagePickerOptions('zip')).toEqual({ properties: ['openFile'], filters: [{ name: 'Design package', extensions: ['zip'] }] });
    expect(packagePickerOptions('folder')).toEqual({ properties: ['openDirectory'] });
  });

  it('ignores an unknown kind', () => {
    expect(packagePickerOptions('exe' as never)).toEqual(packagePickerOptions());
  });
});
