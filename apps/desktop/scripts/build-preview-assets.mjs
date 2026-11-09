/**
 * Builds the Preview's page assets into out/preview/: the notes overlay (an IIFE the
 * view's preload runs in the page) and the view's preload (CommonJS: sandboxed
 * preloads can't be ES modules). electron-vite builds everything else.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out', 'preview');
const common = { bundle: true, minify: true, legalComments: 'eof', logLevel: 'warning', target: 'chrome130' };

await build({ ...common, entryPoints: [join(root, 'src/preview-overlay/entry.ts')], format: 'iife', platform: 'browser', outfile: join(out, 'overlay.js') });
await build({ ...common, entryPoints: [join(root, 'src/preview-overlay/view-preload.ts')], format: 'cjs', platform: 'browser', external: ['electron'], outfile: join(out, 'view-preload.js') });
