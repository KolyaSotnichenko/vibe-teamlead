import { describe, expect, it } from 'vitest';

import { isAllowedPreviewUrl } from '../allowed-url';

describe('where the preview may navigate', () => {
  const origins = ['http://localhost:4123'];

  it("allows the page's own origin, on localhost or loopback", () => {
    expect(isAllowedPreviewUrl('http://localhost:4123/a?b=1#c', origins)).toBe(true);
    expect(isAllowedPreviewUrl('http://127.0.0.1:4123/login', origins)).toBe(true);
    expect(isAllowedPreviewUrl('http://[::1]:4123/', origins)).toBe(true);
  });

  it('refuses another port, other hosts and other schemes', () => {
    for (const url of ['http://localhost:9999/', 'https://accounts.google.com/o/oauth2', 'file:///etc/passwd', 'javascript:alert(1)', 'https://localhost:4123/', 'http://localhost.evil.com:4123/', 'not a url']) {
      expect(isAllowedPreviewUrl(url, origins)).toBe(false);
    }
  });

  it('refuses everything while no origin is known', () => {
    expect(isAllowedPreviewUrl('http://localhost:4123/', [])).toBe(false);
  });
});
