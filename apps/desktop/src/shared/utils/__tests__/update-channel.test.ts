import { describe, expect, it } from 'vitest';

import { channelOnSave, isPrereleaseVersion, updateChannelFor } from '../update-channel';

describe('updateChannelFor', () => {
  it('a stable version follows stable releases', () => {
    expect(updateChannelFor('2.0.0', false)).toBe('latest');
  });

  it('the setting asks for pre-releases', () => {
    expect(updateChannelFor('2.0.0', true)).toBe('beta');
  });

  it('a pre-release follows pre-releases: stable may not exist yet, and it would never hear of its own next version', () => {
    expect(updateChannelFor('2.0.0-beta.1', false)).toBe('beta');
    expect(updateChannelFor('2.0.0-alpha.1', false)).toBe('beta');
  });
});

describe('isPrereleaseVersion', () => {
  it('tells a pre-release from a stable version', () => {
    expect(isPrereleaseVersion('2.0.0-beta.2')).toBe(true);
    expect(isPrereleaseVersion('2.0.0')).toBe(false);
    expect(isPrereleaseVersion('')).toBe(false);
  });
});

describe('saving settings', () => {
  it("doesn't move a pre-release off its channel, whatever the toggle holds", () => {
    expect(channelOnSave('2.0.0-beta.2', false)).toEqual({ channel: 'beta', checkDowngrade: false });
  });

  it('a stable version follows the setting, and turning beta off looks for a way back', () => {
    expect(channelOnSave('2.0.0', true)).toEqual({ channel: 'beta', checkDowngrade: false });
    expect(channelOnSave('2.0.0', false)).toEqual({ channel: 'latest', checkDowngrade: true });
  });
});
