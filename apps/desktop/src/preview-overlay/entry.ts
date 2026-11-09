/** The overlay bundle's entry: react-grab's primitives and @medv/finder, then the overlay. */

import { finder } from '@medv/finder';
import { getElementAtPoint, getElementContext } from 'react-grab/primitives';

import { startOverlay } from './overlay';

const marker = '__vibeTeamleadPreviewOverlay';
const globalScope = window as unknown as Record<string, unknown>;
if (!globalScope[marker]) {
  globalScope[marker] = true;
  startOverlay(window, {
    getElementAtPoint: (x, y) => getElementAtPoint(x, y),
    getElementContext: (element) => getElementContext(element),
    finder: (element) => finder(element, { root: document.body, timeoutMs: 200 }),
  });
}
