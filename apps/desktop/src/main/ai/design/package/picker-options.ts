/**
 * The open dialog for a design package. macOS shows one dialog that takes a .zip or a folder;
 * Windows and Linux can't (asked for both, they show a folder picker only, so a zip can't be
 * chosen), and there the window asks for one kind at a time. Pure.
 */
export type PackagePickKind = 'zip' | 'folder';

const ZIP_FILTER = [{ name: 'Design package', extensions: ['zip'] }];

export function packagePickerOptions(kind?: PackagePickKind): { properties: Array<'openFile' | 'openDirectory'>; filters?: typeof ZIP_FILTER } {
  if (kind === 'zip') return { properties: ['openFile'], filters: ZIP_FILTER };
  if (kind === 'folder') return { properties: ['openDirectory'] };
  return { properties: ['openFile', 'openDirectory'], filters: ZIP_FILTER };
}
