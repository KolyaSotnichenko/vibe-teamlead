/**
 * GitHub's rules for an Actions secret name: letters (stored upper case), digits and underscores,
 * not starting with a digit, and not starting with `GITHUB_` (reserved for GitHub). Upper case
 * only here, as the app writes them. Pure; shared by main (before any call) and the renderer (the form).
 */
export function isValidSecretName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && !name.startsWith('GITHUB_');
}
