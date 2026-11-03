#!/usr/bin/env node
/**
 * Download the security-gate scanners bundled with the macOS app into
 * vendor-bin/ (packaged as Resources/scanners/ by electron-builder):
 *
 *   gitleaks     (MIT)        https://github.com/gitleaks/gitleaks
 *   osv-scanner  (Apache-2.0) https://github.com/google/osv-scanner
 *
 * Versions are pinned; every download is checked against the release's
 * published SHA-256 checksums before it is used.
 *
 * Usage: node scripts/fetch-scanners.cjs [--arch arm64|x64]
 * In development the app also finds gitleaks / osv-scanner on PATH
 * (brew install gitleaks osv-scanner), so running this is optional.
 */

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const GITLEAKS_VERSION = '8.28.0';
const OSV_SCANNER_VERSION = '2.6.0';

const argIndex = process.argv.indexOf('--arch');
const arch = argIndex !== -1 ? process.argv[argIndex + 1] : process.arch;
if (!['arm64', 'x64'].includes(arch)) {
  console.error(`Unsupported arch: ${arch} (expected arm64 or x64)`);
  process.exit(1);
}

const outDir = join(__dirname, '..', 'vendor-bin');

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

async function fetchGitleaks() {
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
  const file = `gitleaks_${GITLEAKS_VERSION}_darwin_${arch}.tar.gz`;
  const checksums = await download(`${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`);
  const archive = await download(`${base}/${file}`);
  verify(archive, expectedDigest(checksums, file), file);

  const work = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  try {
    writeFileSync(join(work, file), archive);
    execFileSync('tar', ['-xzf', join(work, file), '-C', work, 'gitleaks']);
    copyFileSync(join(work, 'gitleaks'), join(outDir, 'gitleaks'));
    chmodSync(join(outDir, 'gitleaks'), 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function fetchOsvScanner() {
  const base = `https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}`;
  const file = `osv-scanner_darwin_${arch === 'x64' ? 'amd64' : 'arm64'}`;
  const checksums = await download(`${base}/osv-scanner_SHA256SUMS`);
  const binary = await download(`${base}/${file}`);
  verify(binary, expectedDigest(checksums, file), file);
  writeFileSync(join(outDir, 'osv-scanner'), binary);
  chmodSync(join(outDir, 'osv-scanner'), 0o755);
}

(async () => {
  mkdirSync(outDir, { recursive: true });
  await fetchGitleaks();
  await fetchOsvScanner();
  console.log(`Scanners ready in ${outDir} (gitleaks ${GITLEAKS_VERSION}, osv-scanner ${OSV_SCANNER_VERSION}, ${arch})`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
