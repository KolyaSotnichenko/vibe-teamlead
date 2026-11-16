#!/usr/bin/env node
/**
 * Download the security-gate scanners bundled with the app into vendor-bin/
 * (packaged as Resources/scanners/ by electron-builder):
 *
 *   gitleaks     (MIT)        https://github.com/gitleaks/gitleaks
 *   osv-scanner  (Apache-2.0) https://github.com/google/osv-scanner
 *
 * Versions are pinned; every download is checked against the release's
 * published SHA-256 checksums before it is used.
 *
 * Usage: node scripts/fetch-scanners.cjs [--platform darwin|win32] [--arch arm64|x64]
 * Both default to the host. Windows is x64 only and gets gitleaks.exe and osv-scanner.exe.
 * In development the app also finds gitleaks / osv-scanner on PATH
 * (brew install gitleaks osv-scanner), so running this is optional.
 */

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const GITLEAKS_VERSION = '8.28.0';
const OSV_SCANNER_VERSION = '2.6.0';

const PLATFORMS = ['darwin', 'win32'];
const ARCHES = ['arm64', 'x64'];

/** --platform / --arch, defaulting to the host. Pure. */
function parseArgs(argv, host) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index !== -1 ? argv[index + 1] : undefined;
  };
  const platform = value('--platform') ?? host.platform;
  // Windows builds are x64 only, whatever machine fetches them
  const arch = value('--arch') ?? (platform === 'win32' ? 'x64' : host.arch);
  if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform} (expected ${PLATFORMS.join(' or ')})`);
  if (!ARCHES.includes(arch)) throw new Error(`Unsupported arch: ${arch} (expected ${ARCHES.join(' or ')})`);
  return { platform, arch };
}

/** The release assets for a platform and architecture, and the names they are saved under. Pure. */
function scannerAssets(platform, arch) {
  const gitleaksBase = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
  const osvBase = `https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}`;
  const gitleaksChecksums = `${gitleaksBase}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`;
  const osvChecksums = `${osvBase}/osv-scanner_SHA256SUMS`;
  const osvArch = arch === 'x64' ? 'amd64' : 'arm64';

  if (platform === 'darwin' && ARCHES.includes(arch)) {
    const gitleaksFile = `gitleaks_${GITLEAKS_VERSION}_darwin_${arch}.tar.gz`;
    const osvFile = `osv-scanner_darwin_${osvArch}`;
    return {
      gitleaks: { url: `${gitleaksBase}/${gitleaksFile}`, checksumsUrl: gitleaksChecksums, file: gitleaksFile, archive: 'tar.gz', member: 'gitleaks', out: 'gitleaks' },
      osv: { url: `${osvBase}/${osvFile}`, checksumsUrl: osvChecksums, file: osvFile, out: 'osv-scanner' },
    };
  }
  if (platform === 'win32' && arch === 'x64') {
    const gitleaksFile = `gitleaks_${GITLEAKS_VERSION}_windows_x64.zip`;
    const osvFile = 'osv-scanner_windows_amd64.exe';
    return {
      gitleaks: { url: `${gitleaksBase}/${gitleaksFile}`, checksumsUrl: gitleaksChecksums, file: gitleaksFile, archive: 'zip', member: 'gitleaks.exe', out: 'gitleaks.exe' },
      osv: { url: `${osvBase}/${osvFile}`, checksumsUrl: osvChecksums, file: osvFile, out: 'osv-scanner.exe' },
    };
  }
  throw new Error(`No scanner builds for ${platform}-${arch}`);
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Find the expected digest for `file` in a `<sha256>  <name>` checksums file. */
function expectedDigest(checksums, file) {
  for (const line of checksums.toString('utf-8').split('\n')) {
    const [digest, name] = line.trim().split(/\s+/);
    if (name && name.replace(/^\*/, '') === file) return digest.toLowerCase();
  }
  throw new Error(`No checksum listed for ${file}`);
}

function verify(buffer, digest, file) {
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== digest) throw new Error(`Checksum mismatch for ${file}: expected ${digest}, got ${actual}`);
}

/**
 * bsdtar reads both .tar.gz and .zip. On Windows that is System32's tar.exe:
 * a shell from Git for Windows puts GNU tar (no zip support) first on PATH.
 */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

async function fetchGitleaks(asset, outDir) {
  const checksums = await download(asset.checksumsUrl);
  const archive = await download(asset.url);
  verify(archive, expectedDigest(checksums, asset.file), asset.file);

  const work = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  try {
    writeFileSync(join(work, asset.file), archive);
    // -C before the archive, so GNU and BSD tar both read it the same way
    execFileSync(tarCommand(), ['-xf', join(work, asset.file), '-C', work, asset.member]);
    copyFileSync(join(work, asset.member), join(outDir, asset.out));
    chmodSync(join(outDir, asset.out), 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function fetchOsvScanner(asset, outDir) {
  const checksums = await download(asset.checksumsUrl);
  const binary = await download(asset.url);
  verify(binary, expectedDigest(checksums, asset.file), asset.file);
  writeFileSync(join(outDir, asset.out), binary);
  chmodSync(join(outDir, asset.out), 0o755);
}

async function main() {
  const { platform, arch } = parseArgs(process.argv.slice(2), { platform: process.platform, arch: process.arch });
  const assets = scannerAssets(platform, arch);
  const outDir = join(__dirname, '..', 'vendor-bin');
  // macOS keeps its stamp's old name, so an existing vendor-bin isn't fetched again
  const stampPath = join(outDir, platform === 'darwin' ? 'VERSIONS' : `VERSIONS-${platform}`);
  const stamp = `gitleaks ${GITLEAKS_VERSION}, osv-scanner ${OSV_SCANNER_VERSION}, ${platform === 'darwin' ? arch : `${platform}-${arch}`}`;

  mkdirSync(outDir, { recursive: true });
  // Already fetched for this version and architecture (local packaging runs this every time)
  if (
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf-8').trim() === stamp &&
    existsSync(join(outDir, assets.gitleaks.out)) &&
    existsSync(join(outDir, assets.osv.out))
  ) {
    console.log(`Scanners already in ${outDir} (${stamp})`);
    return;
  }
  await fetchGitleaks(assets.gitleaks, outDir);
  await fetchOsvScanner(assets.osv, outDir);
  writeFileSync(stampPath, `${stamp}\n`);
  console.log(`Scanners ready in ${outDir} (${stamp})`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, scannerAssets, expectedDigest };
