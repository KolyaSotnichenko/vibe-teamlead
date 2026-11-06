/**
 * electron-builder hook: a DMG must hold the whole app. When its volume is too small
 * the copy drops files and the build still succeeds, so a release can ship that
 * crashes on launch. Mounts each DMG, compares it with the app and checks the
 * signature on the copy. A mismatch fails the build.
 */

const { execFileSync } = require('node:child_process');
const { lstatSync, mkdtempSync, readdirSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');

/** Regular files under a folder, with sizes. Links aren't followed: an app's are relative. */
function filesOf(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.set(relative(root, path), stat.size);
    }
  };
  walk(root);
  return files;
}

/** What the image lacks. Pure. */
function differences(app, image) {
  const found = [];
  for (const [file, size] of app) {
    if (!image.has(file)) found.push(`missing: ${file}`);
    else if (image.get(file) !== size) found.push(`wrong size: ${file} (${size} in the app, ${image.get(file)} in the image)`);
  }
  return found;
}

function verifyDmg(dmg, app, { signature = true } = {}) {
  const mount = mkdtempSync(join(tmpdir(), 'vibe-teamlead-dmg-'));
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { stdio: 'ignore' });
  try {
    const name = app.split('/').pop();
    const copy = join(mount, name);
    const found = differences(filesOf(app), filesOf(copy));
    if (found.length) throw new Error(`${dmg} doesn't hold the whole app:\n${found.slice(0, 20).join('\n')}`);
    if (signature) execFileSync('codesign', ['--verify', '--deep', '--strict', copy], { stdio: 'pipe' });
  } finally {
    execFileSync('hdiutil', ['detach', mount, '-quiet'], { stdio: 'ignore' });
    try {
      rmdirSync(mount);
    } catch {
      // Detaching can remove the mount point
    }
  }
}

/** The app folder electron-builder made for this DMG's architecture. */
function appFor(dmg, outDir, productName) {
  const folder = /arm64/.test(dmg) ? 'mac-arm64' : /universal/.test(dmg) ? 'mac-universal' : 'mac';
  return join(outDir, folder, `${productName}.app`);
}

module.exports = async function afterAllArtifactBuild(result) {
  for (const dmg of result.artifactPaths.filter((path) => path.endsWith('.dmg'))) {
    const app = appFor(dmg, result.outDir, result.configuration.productName);
    verifyDmg(dmg, app);
    console.log(`  • verified ${dmg}: holds the whole app, signature intact`);
  }
  return [];
};
module.exports.differences = differences;
module.exports.verifyDmg = verifyDmg;
