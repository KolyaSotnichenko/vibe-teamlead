/** Text that came from the network (GitHub), made safe to keep and show. Moved from pr-handlers.ts. */

/**
 * Sanitize network data before writing to file
 * Removes potentially dangerous characters and limits length
 */
export function sanitizeNetworkData(data: string, maxLength = 1000000): string {
  // Remove null bytes and other control characters except newlines/tabs/carriage returns
  // Using code points instead of escape sequences to avoid no-control-regex ESLint rule
  const controlCharsPattern = new RegExp(
    "[" +
      String.fromCharCode(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08) + // \x00-\x08
      String.fromCharCode(0x0b, 0x0c) + // \x0B, \x0C (skip \x0A which is newline)
      String.fromCharCode(
        0x0e,
        0x0f,
        0x10,
        0x11,
        0x12,
        0x13,
        0x14,
        0x15,
        0x16,
        0x17,
        0x18,
        0x19,
        0x1a,
        0x1b,
        0x1c,
        0x1d,
        0x1e,
        0x1f
      ) + // \x0E-\x1F
      String.fromCharCode(0x7f) + // \x7F (DEL)
      "]",
    "g"
  );
  let sanitized = data.replace(controlCharsPattern, "");

  // Limit length to prevent DoS
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}
