/**
 * The preview on the whole screen, like a browser's full screen. A window the preview sits in
 * (the task's window) provides this to be told, and grows to the whole screen while it lasts.
 */

import { createContext } from 'react';

export const PreviewFullScreenContext = createContext<((full: boolean) => void) | null>(null);
