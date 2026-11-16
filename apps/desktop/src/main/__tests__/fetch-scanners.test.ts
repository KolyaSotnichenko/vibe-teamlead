import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseArgs, scannerAssets } = require(resolve(__dirname, '../../../scripts/fetch-scanners.cjs')) as {
  parseArgs: (argv: string[], host: { platform: string; arch: string }) => { platform: string; arch: string };
  scannerAssets: (platform: string, arch: string) => {
    gitleaks: { url: string; checksumsUrl: string; file: string; archive: 'tar.gz' | 'zip'; member: string; out: string };
    osv: { url: string; checksumsUrl: string; file: string; out: string };
  };
};

describe('fetch-scanners: which release assets', () => {
  it('macOS: the darwin tarball and binary, named as before', () => {
    const { gitleaks, osv } = scannerAssets('darwin', 'arm64');
    expect(gitleaks.file).toBe('gitleaks_8.28.0_darwin_arm64.tar.gz');
    expect(gitleaks.url).toBe('https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_darwin_arm64.tar.gz');
    expect(gitleaks.checksumsUrl).toBe('https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_checksums.txt');
    expect(gitleaks).toMatchObject({ archive: 'tar.gz', member: 'gitleaks', out: 'gitleaks' });
    expect(osv.file).toBe('osv-scanner_darwin_arm64');
    expect(osv.url).toBe('https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_darwin_arm64');
    expect(osv.checksumsUrl).toBe('https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_SHA256SUMS');
    expect(osv.out).toBe('osv-scanner');
    expect(scannerAssets('darwin', 'x64').osv.file).toBe('osv-scanner_darwin_amd64');
    expect(scannerAssets('darwin', 'x64').gitleaks.file).toBe('gitleaks_8.28.0_darwin_x64.tar.gz');
  });

  it('Windows x64: the zip with gitleaks.exe and the amd64 .exe, saved with .exe names', () => {
    const { gitleaks, osv } = scannerAssets('win32', 'x64');
    expect(gitleaks.file).toBe('gitleaks_8.28.0_windows_x64.zip');
    expect(gitleaks).toMatchObject({ archive: 'zip', member: 'gitleaks.exe', out: 'gitleaks.exe' });
    expect(osv.file).toBe('osv-scanner_windows_amd64.exe');
    expect(osv.out).toBe('osv-scanner.exe');
  });

  it('refuses what has no build', () => {
    expect(() => scannerAssets('win32', 'arm64')).toThrow(/win32-arm64/);
    expect(() => scannerAssets('linux', 'x64')).toThrow(/linux/);
  });
});

describe('fetch-scanners: arguments', () => {
  const mac = { platform: 'darwin', arch: 'arm64' };

  it('defaults to the host', () => {
    expect(parseArgs([], mac)).toEqual(mac);
  });

  it('takes --platform and --arch', () => {
    // Windows is x64 only, so a Mac (arm64) fetching for it gets x64
    expect(parseArgs(['--platform', 'win32'], mac)).toEqual({ platform: 'win32', arch: 'x64' });
    expect(parseArgs(['--platform', 'win32', '--arch', 'x64'], mac)).toEqual({ platform: 'win32', arch: 'x64' });
    expect(parseArgs(['--arch', 'x64'], mac)).toEqual({ platform: 'darwin', arch: 'x64' });
  });

  it('rejects an unknown platform or arch', () => {
    expect(() => parseArgs(['--platform', 'linux'], mac)).toThrow(/platform/);
    expect(() => parseArgs(['--arch', 'ia32'], mac)).toThrow(/arch/);
  });
});
