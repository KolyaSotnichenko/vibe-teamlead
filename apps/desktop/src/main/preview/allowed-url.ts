/**
 * The preview view stays on its own app: the page's origin, also reached as
 * 127.0.0.1 or ::1. Anything else (another port, a real site, file:, javascript:)
 * is not loaded in it. Pure.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedPreviewUrl(url: string, origins: string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' || !LOOPBACK.has(target.hostname)) return false;
  return origins.some((origin) => {
    try {
      const allowed = new URL(origin);
      return allowed.protocol === 'http:' && LOOPBACK.has(allowed.hostname) && allowed.port === target.port;
    } catch {
      return false;
    }
  });
}
