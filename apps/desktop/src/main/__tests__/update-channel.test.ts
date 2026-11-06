import { describe, expect, it } from 'vitest';

import { updateChannelFor } from '../update-channel';

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
