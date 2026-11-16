/**
 * A path inside WSL as Windows shows it: \\wsl$\<distro>\… or \\wsl.localhost\<distro>\…
 * (any case, either slash, also the \\?\UNC\ long form). Projects there aren't
 * supported yet: agents, git and checks run on Windows and would reach the files
 * through the slow 9P share with Linux permissions and line endings. Pure.
 */

const WSL_SHARE = /^(?:[\\/]{2}\?[\\/]UNC[\\/]|[\\/]{2})wsl(?:\$|\.localhost)(?:[\\/]|$)/i;

export function isWslPath(path: string): boolean {
  return WSL_SHARE.test(path);
}

/** What the main process answers when a WSL project is added (the UI shows its own translated text). */
export const WSL_PROJECT_ERROR =
  "Projects inside WSL aren't supported yet. Keep the project on a Windows drive (for example C:\\Users\\you\\projects) and open it from there.";
