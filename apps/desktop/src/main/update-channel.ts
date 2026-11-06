/**
 * Which releases this app follows. A pre-release follows pre-releases whatever the
 * setting says: a stable release may not exist yet, and on the stable channel it
 * would never hear of its own next version. Pure.
 */
export function updateChannelFor(version: string, betaUpdates: boolean): 'latest' | 'beta' {
  return betaUpdates || version.includes('-') ? 'beta' : 'latest';
}
