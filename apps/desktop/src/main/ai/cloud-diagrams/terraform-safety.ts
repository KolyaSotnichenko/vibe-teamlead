/**
 * Before the app runs Terraform's plan on agent-written code (the after-merge
 * redraw), a static check of every Terraform file of the commit. It refuses what can
 * run programs or fetch code from where nobody chose: `data "external"`, any
 * provisioner (local-exec, remote-exec, file), modules from anywhere but the public
 * registry or a folder inside the repository, providers from other registries, and
 * Terraform JSON files (not read here). A backend of any kind is fine: TerraVision
 * plans with a local backend override and neutralises a `cloud {}` block.
 *
 * A word-level check of HCL, not a parser: it errs on the side of refusing. Pure.
 */

import { dirname, isAbsolute, normalize, posix } from 'node:path';

export interface TerraformFile {
  /** Relative to the repository root */
  path: string;
  text: string;
}

/** Comments out (outside strings), so a commented-out block neither passes nor fails the check */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

/** The bodies of blocks that open with `header` (a regex source), matched by braces. */
function blocks(text: string, header: string): string[] {
  const found: string[] = [];
  const re = new RegExp(`${header}\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    let inString = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== '\\') inString = !inString;
      else if (!inString && c === '{') depth++;
      else if (!inString && c === '}') depth--;
    }
    found.push(text.slice(start, i - 1));
  }
  return found;
}

const REGISTRY_MODULE = /^(registry\.terraform\.io\/|registry\.opentofu\.org\/)?[A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w-]*$/;
const REGISTRY_PROVIDER = /^(registry\.terraform\.io\/|registry\.opentofu\.org\/)?[A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w-]*$/;

function localModuleInside(source: string, file: string): boolean {
  if (!/^\.\.?\//.test(source)) return false;
  const target = posix.normalize(posix.join(dirname(file).split('\\').join('/'), source));
  return !isAbsolute(normalize(target)) && target !== '..' && !target.startsWith('../');
}

/** Why the code may not be planned, or undefined when it may. */
export function terraformUnsafe(files: TerraformFile[]): string | undefined {
  // A local module must be a folder whose files were checked here (not one the file scan skips, like vendor/)
  const checkedDirs = new Set(files.map((f) => posix.dirname(f.path.split('\\').join('/'))));
  for (const { path, text: raw } of files) {
    if (/\.tf\.json$/i.test(path)) return `${path}: Terraform JSON files aren't checked, so the code isn't planned`;
    const text = stripComments(raw);
    if (/\bdata\s+"external"/.test(text)) return `${path}: a data "external" block runs a program`;
    if (/\bprovisioner\s+"/.test(text) || /\b(local|remote)-exec\b/.test(text)) return `${path}: a provisioner runs commands`;
    for (const body of blocks(text, 'module\\s+"[^"]*"')) {
      const source = /\bsource\s*=\s*"([^"]*)"/.exec(body)?.[1];
      if (source === undefined) return `${path}: a module without a plain source`;
      if (localModuleInside(source, path)) {
        const target = posix.normalize(posix.join(posix.dirname(path.split('\\').join('/')), source)).replace(/\/$/, '');
        if (!checkedDirs.has(target)) return `${path}: module folder "${source}" wasn't checked (hidden, a dependency folder, or empty)`;
        continue;
      }
      if (!REGISTRY_MODULE.test(source)) return `${path}: module source "${source}" is neither the public registry nor a folder of the repository`;
    }
    for (const body of blocks(text, 'required_providers')) {
      for (const match of body.matchAll(/\bsource\s*=\s*"([^"]*)"/g)) {
        if (!REGISTRY_PROVIDER.test(match[1])) return `${path}: provider source "${match[1]}" is not the public Terraform or OpenTofu registry`;
      }
    }
  }
  return undefined;
}
