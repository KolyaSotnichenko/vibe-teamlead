/**
 * TerraVision (github.com/patrickchugh/terravision, AGPL-3.0): cloud architecture
 * diagrams (AWS, Azure, Google Cloud) from a JSON graph or from Terraform code.
 *
 * Experimental and optional (Settings → Agents, on by default). Not bundled: its
 * release is a Python package (with boto3) that also needs Graphviz and Git, and
 * Terraform or OpenTofu to draw from code. The app never installs anything; it
 * finds what is there and says what is missing.
 *
 * Confirmed from TerraVision 0.56.1's source:
 * - `terravision draw --source <dir|x.tvg.json> --format svg|drawio --outfile <name>`
 *   writes `<name>[-provider].<ext>` in the working directory;
 *   `terravision graphdata --source <dir> --outfile <name>` writes `<name>.tvg.json`;
 *   `terravision visualise --source <dir>` writes a self-contained HTML page
 *   (not from a graph file).
 * - From a directory it runs `terraform init` (downloads providers and modules:
 *   network) and `terraform plan -refresh=false` with a local backend override,
 *   with the inherited environment. A graph JSON needs no Terraform.
 * - `terravision mcp --output-dir <dir>` (extra `mcp`) serves diagram_guide,
 *   render_graph (always saves PNG, SVG, draw.io and .tvg.json), generate_diagram,
 *   generate_architecture_graph, generate_interactive_html, open_diagram_file.
 *
 * Pure, no Electron: the worker uses it.
 */

import { join, posix, win32 } from 'node:path';

import { envValue, WINDOWS_HOST_ENV, withPath } from '../../platform/env';
import { searchPath } from '../../platform/exec';

type PlatformKey = 'darwin' | 'win32' | 'linux';

/** The TerraVision release the app runs (uvx fetches exactly this one). */
export const TERRAVISION_VERSION = '0.56.1';

export type CloudTool = 'uv' | 'graphviz' | 'git' | 'terraform';

export interface CloudToolsReadiness {
  /** TerraVision can draw (from a graph): a launcher, Graphviz and Git */
  ready: boolean;
  /** It can also draw from Terraform code: Terraform or OpenTofu too */
  drawFromCode: boolean;
  /** What is not installed, in a fixed order */
  missing: CloudTool[];
  /** Absolute paths of what was found */
  uvx?: string;
  terravision?: string;
  engine?: 'terraform' | 'tofu';
}

/** What is installed, through `find` (an executable's path on the search PATH, or undefined). */
export function detectCloudTools(find: (name: string) => string | undefined): CloudToolsReadiness {
  const uvx = find('uvx');
  const terravision = find('terravision');
  const graphviz = !!find('dot') && !!find('gvpr');
  const git = !!find('git');
  const engine = find('terraform') ? 'terraform' : find('tofu') ? 'tofu' : undefined;
  const missing: CloudTool[] = [];
  if (!uvx && !terravision) missing.push('uv');
  if (!graphviz) missing.push('graphviz');
  if (!git) missing.push('git');
  if (!engine) missing.push('terraform');
  const ready = (!!uvx || !!terravision) && graphviz && git;
  return {
    ready,
    drawFromCode: ready && !!engine,
    missing,
    ...(uvx ? { uvx } : {}),
    ...(terravision ? { terravision } : {}),
    ...(engine ? { engine } : {}),
  };
}

/** How to start TerraVision: a pinned release through uvx, else an installed one. */
export function terravisionCommand(tools: CloudToolsReadiness, mcp: boolean): { file: string; args: string[] } | undefined {
  if (!tools.ready) return undefined;
  if (tools.uvx) return { file: tools.uvx, args: ['--from', `terravision${mcp ? '[mcp]' : ''}==${TERRAVISION_VERSION}`, 'terravision'] };
  if (tools.terravision) return { file: tools.terravision, args: [] };
  return undefined;
}

/** One install line per missing tool (Homebrew on macOS, winget on Windows). Commands, so not translated. */
export function installHints(platform: PlatformKey): Record<CloudTool, string> {
  if (platform === 'win32') {
    return {
      uv: 'winget install --id astral-sh.uv -e',
      graphviz: 'winget install --id Graphviz.Graphviz -e',
      git: 'winget install --id Git.Git -e',
      terraform: 'winget install --id OpenTofu.Tofu -e   (or Hashicorp.Terraform)',
    };
  }
  if (platform === 'darwin') {
    return {
      uv: 'brew install uv',
      graphviz: 'brew install graphviz',
      git: 'brew install git',
      terraform: 'brew install opentofu   (or hashicorp/tap/terraform)',
    };
  }
  return {
    uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    graphviz: 'sudo apt install graphviz',
    git: 'sudo apt install git',
    terraform: 'https://opentofu.org/docs/intro/install/',
  };
}

/** Host variables TerraVision, uv, Graphviz and Terraform need; no keys, no tokens, no cloud settings. */
const KEPT = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'USER', 'LOGNAME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'] as const;

/**
 * The environment TerraVision (and the Terraform it starts) runs with: a short
 * allowlist, a home folder of its own so no cloud CLI's saved login is found
 * (~/.aws, ~/.azure, gcloud's application default credentials, Terraform's
 * tokens), and each cloud's credential settings pointed into that empty folder.
 * uv keeps its real cache and Pythons, so a pinned TerraVision is fetched once. Pure.
 */
export function cloudSafeEnv(host: NodeJS.ProcessEnv, options: { platform: PlatformKey; sandboxHome: string }): NodeJS.ProcessEnv {
  const { platform, sandboxHome } = options;
  const at = (...parts: string[]) => (platform === 'win32' ? win32.join(sandboxHome, ...parts) : posix.join(sandboxHome, ...parts));
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEPT) {
    const value = host[name];
    if (value) env[name] = value;
  }
  if (platform === 'win32') {
    for (const name of WINDOWS_HOST_ENV) {
      const value = envValue(host, name);
      if (value) env[name] = value;
    }
  }

  const realHome = envValue(host, platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? '';
  const uvCache = envValue(host, 'UV_CACHE_DIR')
    ?? (platform === 'win32'
      ? win32.join(envValue(host, 'LOCALAPPDATA') ?? win32.join(realHome, 'AppData', 'Local'), 'uv', 'cache')
      : posix.join(envValue(host, 'XDG_CACHE_HOME') ?? posix.join(realHome, '.cache'), 'uv'));
  const uvPython = envValue(host, 'UV_PYTHON_INSTALL_DIR')
    ?? (platform === 'win32'
      ? win32.join(envValue(host, 'APPDATA') ?? win32.join(realHome, 'AppData', 'Roaming'), 'uv', 'data', 'python')
      : posix.join(envValue(host, 'XDG_DATA_HOME') ?? posix.join(realHome, '.local', 'share'), 'uv', 'python'));

  Object.assign(env, {
    HOME: sandboxHome,
    UV_CACHE_DIR: uvCache,
    UV_PYTHON_INSTALL_DIR: uvPython,
    // Nothing to find, and nothing to ask the machine's metadata service for
    AWS_SHARED_CREDENTIALS_FILE: at('aws', 'credentials'),
    AWS_CONFIG_FILE: at('aws', 'config'),
    AWS_EC2_METADATA_DISABLED: 'true',
    AZURE_CONFIG_DIR: at('azure'),
    CLOUDSDK_CONFIG: at('gcloud'),
    KUBECONFIG: at('kube', 'config'),
    TF_CLI_CONFIG_FILE: at('terraformrc'),
    TF_PLUGIN_CACHE_DIR: at('terraform-plugins'),
    // Terraform's working data in a folder of its own: a .terraform folder in the code is never read
    TF_DATA_DIR: at('terraform-data'),
    TF_INPUT: '0',
    TF_IN_AUTOMATION: '1',
    CHECKPOINT_DISABLE: '1',
  });
  if (platform === 'win32') {
    env.USERPROFILE = sandboxHome;
    env.APPDATA = at('AppData', 'Roaming');
  }
  return withPath(env, searchPath([], platform, host));
}
