/**
 * Which releases this app follows. A pre-release follows pre-releases whatever the
 * setting says: a stable release may not exist yet, and on the stable channel it
 * would never hear of its own next version. Pure.
 */
export type UpdateChannelName = 'latest' | 'beta';

export function isPrereleaseVersion(version: string): boolean {
  return version.includes('-');
}

export function updateChannelFor(version: string, betaUpdates: boolean): UpdateChannelName {
  return betaUpdates || isPrereleaseVersion(version) ? 'beta' : 'latest';
}

/** What saving the settings does to the channel. Every save carries the setting, changed or not. */
export function channelOnSave(version: string, betaUpdates: boolean): { channel: UpdateChannelName; checkDowngrade: boolean } {
  const channel = updateChannelFor(version, betaUpdates);
  return { channel, checkDowngrade: channel === 'latest' };
}
