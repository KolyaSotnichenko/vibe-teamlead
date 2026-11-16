#!/usr/bin/env node
/**
 * Check a packaged Windows app before it is released: electron-builder succeeds
 * even when a per-platform resource didn't make it in (a wrong path in
 * win.extraResources, a scanner that wasn't fetched), and the app then starts
 * without its agents, its code graph or its checks.
 *
 * Usage: node scripts/verify-win.cjs [dist/win-unpacked]
 * Exits 1 and names what is missing.
 */

const { closeSync, existsSync, openSync, readSync, readdirSync, statSync } = require('node:fs');
const { join, relative, sep } = require('node:path');

const REQUIRED_FILES = [
  'claude-code/claude.exe',
  'codegraph/node.exe',
  'codegraph/lib/dist/bin/codegraph.js',
  'scanners/gitleaks.exe',
  'scanners/osv-scanner.exe',
  // node-pty's native files load from outside the asar
  'app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64/conpty.node',
  'app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64/conpty_console_list.node',
];
const REQUIRED_PLUGINS = ['drawio', 'frontend-design', 'gsap-skills', 'superpowers', 'ux-review', 'vibe-teamlead-skills'];
const REQUIRED_IN_ASAR = ['/out/preview/overlay.js'];

/**
 * What the app lacks. `resources`: paths under resources/ with '/' separators;
 * `asar`: paths inside app.asar, each starting with '/'. Pure.
 */
function missingFromWindowsApp(resources, asar) {
  const missing = REQUIRED_FILES.filter((file) => !resources.has(file));
  for (const plugin of REQUIRED_PLUGINS) {
    const prefix = `plugins/${plugin}/`;
    if (![...resources].some((file) => file.startsWith(prefix))) missing.push(prefix);
  }
  for (const file of REQUIRED_IN_ASAR) if (!asar.has(file)) missing.push(`app.asar:${file}`);
  return missing;
}

/** Files under a folder, relative, with '/' separators. */
function filesUnder(root) {
  const files = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.add(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return files;
}

/**
 * Files inside an asar archive, read from its header: a pickle holding the
 * header's size, then a pickle holding the header as a JSON string.
 */
function asarFiles(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const jsonLength = head.readInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    readSync(fd, json, 0, jsonLength, 16);
    const header = JSON.parse(json.toString('utf-8'));
    const files = new Set();
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = `${prefix}/${name}`;
        if (entry.files) walk(entry, path);
        else files.add(path);
      }
    };
    walk(header, '');
    return files;
  } finally {
    closeSync(fd);
  }
}

function main() {
  const appDir = process.argv[2] ?? join(__dirname, '..', 'dist', 'win-unpacked');
  const resourcesDir = join(appDir, 'resources');
  if (!existsSync(resourcesDir)) {
    console.error(`No packaged Windows app at ${appDir}`);
    process.exit(1);
  }
  const resources = filesUnder(resourcesDir);
  const asar = resources.has('app.asar') ? asarFiles(join(resourcesDir, 'app.asar')) : new Set();
  const missing = missingFromWindowsApp(resources, asar);
  if (!resources.has('app.asar')) missing.unshift('app.asar');
  if (missing.length) {
    console.error(`The Windows app at ${appDir} is missing:\n${missing.map((file) => `  ${file}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Verified ${appDir}: Claude Code, CodeGraph, scanners, node-pty, preview overlay and plugins are in place`);
}

if (require.main === module) main();

module.exports = { missingFromWindowsApp, asarFiles, filesUnder };
