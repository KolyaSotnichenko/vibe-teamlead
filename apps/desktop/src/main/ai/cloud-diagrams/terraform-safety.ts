/**
 * Before the app runs Terraform's plan on agent-written code (the after-merge
 * redraw), a static check of every Terraform file of the commit. TerraVision has no
 * static mode, so this is what stands between that code and `terraform init/plan`.
 * It is an allowlist, and it refuses what it can't read:
 *
 * - Providers: only a vetted set from the public Terraform / OpenTofu registry
 *   (VETTED_PROVIDERS): cloud APIs and pure helpers, none of which runs a local
 *   program or reads a local file because of what the code says, apart from the
 *   provider attributes refused below.
 * - Resources and data sources: only of those providers (so no `external`, no
 *   `local_file`, no `http`, no `terraform_remote_state`).
 * - No provisioner (local-exec, remote-exec, file) anywhere; in provider blocks no
 *   attribute that names a file, a process, a command, a token or a plugin.
 * - Modules: only local folders inside the repository whose files were checked
 *   here; a registry or remote module would be fetched and run unchecked.
 * - File functions only on literal relative paths inside the repository.
 * - Terraform JSON (.tf.json, .tofu.json) is refused: this check reads HCL.
 * - Any block or syntax it does not recognise: refused.
 *
 * A small HCL reader, not a full parser: on anything unexpected it refuses. Pure.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface TerraformFile {
  /** Relative to the repository root */
  path: string;
  text: string;
}

/** Local name → registry type. */
export const VETTED_PROVIDERS: Record<string, string> = {
  aws: 'hashicorp/aws',
  azurerm: 'hashicorp/azurerm',
  azuread: 'hashicorp/azuread',
  google: 'hashicorp/google',
  'google-beta': 'hashicorp/google-beta',
  random: 'hashicorp/random',
  tls: 'hashicorp/tls',
  time: 'hashicorp/time',
};

/** Resource and data source type prefixes of the vetted providers (google-beta uses google_) */
const TYPE_PREFIXES = ['aws_', 'azurerm_', 'azuread_', 'google_', 'random_', 'tls_', 'time_'];
/** Built in, and harmless without provisioners (a resource only) */
const BUILTIN_RESOURCES = new Set(['terraform_data']);

const TOP_LEVEL = new Set(['terraform', 'provider', 'resource', 'data', 'variable', 'output', 'locals', 'module', 'moved', 'import', 'removed', 'check']);

const PROVIDER_ATTRIBUTE_DENIED = /(file|process|command|exec|program|path|helper|token|script|plugin|endpoint)/i;
const FILE_FUNCTION = /\b(file|filebase64|filemd5|filesha1|filesha256|filesha512|filebase64sha256|filebase64sha512|fileexists|fileset|templatefile|pathexpand|abspath)\s*\(/g;

export class UnreadableTerraform extends Error {}

export interface HclBlock {
  type: string;
  labels: string[];
  attributes: Map<string, string>;
  blocks: HclBlock[];
}

/** HCL native syntax → blocks and raw attribute values. Throws UnreadableTerraform on anything unexpected. */
export function readHcl(text: string): HclBlock[] {
  let i = 0;
  const n = text.length;
  const fail = (what: string): never => {
    throw new UnreadableTerraform(`line ${text.slice(0, i).split('\n').length}: ${what}`);
  };

  const skipSpace = (newlines: boolean) => {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) i++;
      else if (c === '#' || (c === '/' && text[i + 1] === '/')) {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) fail('unclosed comment');
        i = end + 2;
      } else break;
    }
  };
  const ident = (): string | undefined => {
    const m = /^[A-Za-z_][\w-]*/.exec(text.slice(i, i + 200));
    if (!m) return undefined;
    i += m[0].length;
    return m[0];
  };
  /** A label: a plain string, no interpolation, no line break */
  const label = (): string => {
    i++;
    let out = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\n') fail('line break in a label');
      if (text[i] === '$' && text[i + 1] === '{') fail('interpolation in a label');
      if (text[i] === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      out += text[i++];
    }
    if (i >= n) fail('unclosed label');
    i++;
    return out;
  };
  const string = () => {
    i++;
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        depth++;
        i += 2;
        continue;
      }
      if (depth > 0 && c === '}') depth--;
      else if (depth === 0 && c === '"') break;
      else if (c === '\n') fail('line break in a string');
      i++;
    }
    if (i >= n) fail('unclosed string');
    i++;
  };
  const heredoc = () => {
    const m = /^<<-?([A-Za-z_]\w*)\r?\n/.exec(text.slice(i, i + 200));
    if (!m) fail('unrecognised heredoc');
    const close = new RegExp(`\\n[ \\t]*${m![1]}[ \\t]*(?=\\r?\\n|$)`, 'g');
    close.lastIndex = i + m![0].length - 1;
    const end = close.exec(text);
    if (!end) fail('unclosed heredoc');
    i = end!.index + end![0].length;
  };

  /** An expression up to the end of its line, brackets, strings and heredocs balanced. Its raw text. */
  const expression = (): string => {
    const start = i;
    const stack: string[] = [];
    while (i < n) {
      const c = text[i];
      if (c === '"') string();
      else if (c === '<' && text[i + 1] === '<') heredoc();
      else if (c === '(' || c === '[' || c === '{') {
        stack.push(c === '(' ? ')' : c === '[' ? ']' : '}');
        i++;
      } else if (c === ')' || c === ']' || c === '}') {
        if (!stack.length) break;
        if (stack.pop() !== c) fail('unbalanced brackets');
        i++;
      } else if (c === '#' || (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))) {
        if (!stack.length && text[i + 1] !== '*') break;
        skipSpace(false);
      } else if (c === '\n' && !stack.length) break;
      else i++;
    }
    if (stack.length) fail('unclosed bracket');
    return text.slice(start, i).trim();
  };

  const body = (closing: boolean): { attributes: Map<string, string>; blocks: HclBlock[] } => {
    const attributes = new Map<string, string>();
    const blocks: HclBlock[] = [];
    for (;;) {
      skipSpace(true);
      if (i >= n) {
        if (closing) fail('unclosed block');
        break;
      }
      if (text[i] === '}') {
        if (!closing) fail('unexpected }');
        i++;
        break;
      }
      const name = ident();
      if (!name) fail(`unrecognised syntax "${text.slice(i, i + 20).split('\n')[0]}"`);
      skipSpace(false);
      if (text[i] === '=' && text[i + 1] !== '=') {
        i++;
        skipSpace(false);
        if (attributes.has(name!)) fail(`"${name}" set twice`);
        attributes.set(name!, expression());
        continue;
      }
      const labels: string[] = [];
      while (i < n && text[i] !== '{') {
        if (text[i] === '"') labels.push(label());
        else {
          const word = ident();
          if (!word) fail(`unrecognised block "${name}"`);
          labels.push(word!);
        }
        skipSpace(false);
      }
      if (text[i] !== '{') fail(`unrecognised block "${name}"`);
      i++;
      blocks.push({ type: name!, labels, ...body(true) });
    }
    return { attributes, blocks };
  };

  return body(false).blocks;
}

/** A relative path from `fromDir` that stays inside the repository, normalised; else undefined. */
function insideRepo(fromDir: string, relative: string): string | undefined {
  if (!relative || relative.startsWith('/') || relative.startsWith('\\') || relative.startsWith('~') || /^[A-Za-z]:/.test(relative)) return undefined;
  const target = posix.normalize(posix.join(fromDir, relative.split('\\').join('/'))).replace(/\/$/, '');
  return target === '..' || target.startsWith('../') ? undefined : target || '.';
}

const PROVIDER_SOURCE = /^(?:(?:registry\.terraform\.io|registry\.opentofu\.org)\/)?([\w-]+\/[\w-]+)$/i;

const allNested = (block: HclBlock): HclBlock[] => [block, ...block.blocks.flatMap(allNested)];

function fileFunctionUnsafe(path: string, dir: string, text: string): string | undefined {
  for (const call of text.matchAll(FILE_FUNCTION)) {
    const fn = call[1];
    if (fn === 'pathexpand' || fn === 'abspath') return `${path}: ${fn}() resolves paths outside the repository`;
    const rest = text.slice((call.index ?? 0) + call[0].length).trimStart();
    const literal = /^"([^"$]*)"/.exec(rest);
    if (literal) {
      if (insideRepo(dir, literal[1]) === undefined) return `${path}: ${fn}("${literal[1]}") reads outside the repository`;
      continue;
    }
    const fromModule = /^"\$\{path\.(?:module|root)\}([^"$]*)"/.exec(rest) ?? /^path\.(?:module|root)\s*\)/.exec(rest);
    if (fromModule && !(fromModule[1] ?? '').includes('..')) continue;
    return `${path}: ${fn}() with a path that isn't a literal inside the repository`;
  }
  return undefined;
}

/** Why the code may not be planned, or undefined when it may. */
export function terraformUnsafe(files: TerraformFile[]): string | undefined {
  const vettedSources = new Set(Object.values(VETTED_PROVIDERS));
  const checkedDirs = new Set(files.map((f) => posix.dirname(f.path.split('\\').join('/'))));
  for (const { path: rawPath, text } of files) {
    const path = rawPath.split('\\').join('/');
    const dir = posix.dirname(path);
    if (/\.json$/i.test(path)) return `${path}: Terraform JSON files aren't checked, so the code isn't planned`;
    let blocks: HclBlock[];
    try {
      blocks = readHcl(text);
    } catch (error) {
      return `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const files = fileFunctionUnsafe(path, dir, text);
    if (files) return files;

    for (const block of blocks) {
      if (!TOP_LEVEL.has(block.type)) return `${path}: unrecognised block "${block.type}"`;
      if (allNested(block).some((nested) => nested.type === 'provisioner')) return `${path}: a provisioner runs commands`;
      const name = block.labels[0] ?? '';
      if (block.type === 'resource' || block.type === 'data') {
        if (block.labels.length !== 2) return `${path}: ${block.type} block with ${block.labels.length} labels`;
        const builtin = block.type === 'resource' && BUILTIN_RESOURCES.has(name);
        if (!builtin && !TYPE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
          return `${path}: ${block.type} "${name}" is not of a vetted provider (${Object.keys(VETTED_PROVIDERS).join(', ')})`;
        }
      }
      if (block.type === 'provider') {
        if (!(name in VETTED_PROVIDERS)) return `${path}: provider "${name}" is not a vetted provider`;
        for (const nested of allNested(block)) {
          for (const [attribute, value] of nested.attributes) {
            if (PROVIDER_ATTRIBUTE_DENIED.test(attribute)) return `${path}: provider "${name}" sets "${attribute}"`;
            if (/credential_process/i.test(value)) return `${path}: provider "${name}" names a process`;
          }
        }
      }
      if (block.type === 'module') {
        const source = /^"([^"$]*)"$/.exec(block.attributes.get('source') ?? '')?.[1];
        if (source === undefined) return `${path}: module "${name}" has no plain source`;
        if (!/^\.\.?\//.test(source)) return `${path}: module source "${source}" is not a folder of the repository (registry and remote modules are fetched unchecked)`;
        const target = insideRepo(dir, source);
        if (!target) return `${path}: module source "${source}" leads outside the repository`;
        if (!checkedDirs.has(target)) return `${path}: module folder "${source}" wasn't checked (hidden, a dependency folder, or empty)`;
      }
      if (block.type === 'terraform') {
        for (const nested of block.blocks) {
          if (nested.type !== 'required_providers') continue;
          for (const [local, value] of nested.attributes) {
            const source = /\bsource\s*=\s*"([^"]*)"/.exec(value)?.[1];
            const type = source === undefined ? VETTED_PROVIDERS[local] : PROVIDER_SOURCE.exec(source)?.[1]?.toLowerCase();
            if (!type || !vettedSources.has(type)) return `${path}: provider "${local}"${source ? ` (${source})` : ''} is not a vetted provider`;
          }
        }
      }
    }
  }
  return undefined;
}

/** Terraform and OpenTofu files Terraform would load, HCL or JSON */
export const TERRAFORM_FILE = /\.(tf|tofu)(\.json)?$/i;

/**
 * Every Terraform file of a repository copy (relative, with /), every folder but .git
 * walked. Throws UnreadableTerraform on a symbolic link anywhere (it could lead the
 * plan out of the copy) or when there are more than `limit` entries to walk.
 */
export function walkTerraformFiles(root: string, limit = 50_000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(rel ? join(root, rel) : root)) {
      if (!rel && name === '.git') continue;
      if (++seen > limit) throw new UnreadableTerraform(`more than ${limit} files to check`);
      const relPath = rel ? `${rel}/${name}` : name;
      const info = lstatSync(join(root, relPath));
      if (info.isSymbolicLink()) throw new UnreadableTerraform(`${relPath} is a symbolic link`);
      if (info.isDirectory()) walk(relPath);
      else if (info.isFile() && TERRAFORM_FILE.test(name)) found.push(relPath);
    }
  };
  walk('');
  return found.sort();
}
