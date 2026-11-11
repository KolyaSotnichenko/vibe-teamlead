/**
 * Safe unpack of a designer's design-system package (a zip or a folder).
 *
 * Nothing from the package is executed. Only regular files with an allowed
 * extension are copied into `dest`; symlinks and anything that would resolve
 * outside the package root are skipped as 'unsafe'.
 */
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UNZIP_TIMEOUT_MS = 60_000;

/** Runs unzip with stdin closed (no password prompt) and a timeout. */
function runUnzip(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: UNZIP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
    child.stdin?.end();
  });
}

function assertNoOverlap(source: string, dest: string): void {
  const a = path.resolve(source);
  const b = path.resolve(dest);
  const inside = (outer: string, inner: string): boolean => {
    const rel = path.relative(outer, inner);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(a, b) || inside(b, a)) {
    throw new Error('Design package source and destination overlap');
  }
}

export const PACKAGE_LIMITS = {
  totalBytes: 60 * 1024 * 1024,
  files: 2000,
  fileBytes: 20 * 1024 * 1024,
};

export const PACKAGE_EXTENSIONS: Set<string> = new Set([
  '.md', '.txt', '.json', '.css', '.scss', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf',
  '.otf', '.ttf', '.woff', '.woff2',
]);

export type SkipReason = 'type' | 'size' | 'unsafe' | 'limit';

export interface UnpackResult {
  /** POSIX paths relative to `dest`, sorted. */
  files: string[];
  skipped: Array<{ path: string; reason: SkipReason }>;
}

export interface UnpackOptions {
  unzip?: string;
  limits?: Partial<typeof PACKAGE_LIMITS>;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function unpackDesignPackage(
  source: string,
  dest: string,
  opts: UnpackOptions = {},
): Promise<UnpackResult> {
  const limits = { ...PACKAGE_LIMITS, ...opts.limits };
  assertNoOverlap(source, dest);
  try {
    assertNoOverlap(await realpath(source), await realpath(dest));
  } catch (e) {
    if ((e as Error).message.includes('overlap')) throw e;
  }
  let tmp: string | null = null;
  try {
    const info = await lstat(source);
    let root = source;
    if (info.isFile()) {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'vt-design-pkg-'));
      const bin = opts.unzip ?? '/usr/bin/unzip';
      const listing = await runUnzip(bin, ['-l', '-P', '', source]);
      const m = /^\s*(\d+)\s+(\d+)\s+files?\s*$/m.exec(listing);
      if (!m) throw new Error('Could not read the design package archive');
      if (Number(m[1]) > limits.totalBytes) throw new Error('Design package is too large');
      if (Number(m[2]) > limits.files) throw new Error('Design package has too many files');
      await runUnzip(bin, ['-qq', '-o', '-P', '', source, '-d', tmp]);
      root = tmp;
    } else if (!info.isDirectory()) {
      throw new Error('Design package must be a zip file or a folder');
    }
    const realRoot = await realpath(root);

    const files: string[] = [];
    const skipped: UnpackResult['skipped'] = [];
    const plan: string[] = [];
    let total = 0;

    const walk = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir)).sort();
      for (const name of entries) {
        const abs = path.join(dir, name);
        const rel = path.relative(realRoot, abs).split(path.sep).join('/');
        const st = await lstat(abs);
        if (st.isSymbolicLink()) {
          skipped.push({ path: rel, reason: 'unsafe' });
          continue;
        }
        if (st.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!st.isFile()) {
          skipped.push({ path: rel, reason: 'unsafe' });
          continue;
        }
        if (!isInside(realRoot, await realpath(abs))) {
          skipped.push({ path: rel, reason: 'unsafe' });
          continue;
        }
        if (!PACKAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
          skipped.push({ path: rel, reason: 'type' });
          continue;
        }
        if (st.size > limits.fileBytes) {
          skipped.push({ path: rel, reason: 'size' });
          continue;
        }
        if (files.length >= limits.files || total + st.size > limits.totalBytes) {
          skipped.push({ path: rel, reason: 'limit' });
          continue;
        }
        total += st.size;
        files.push(rel);
        plan.push(rel);
      }
    };
    await walk(realRoot);

    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    for (const rel of plan) {
      const target = path.join(dest, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(realRoot, ...rel.split('/')), target);
    }

    files.sort();
    skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, skipped };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
