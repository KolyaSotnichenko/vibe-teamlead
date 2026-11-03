/**
 * Theme constants
 * Color themes for multi-theme support with light/dark mode variants
 */

import type { ColorThemeDefinition } from '../types/settings';

// ============================================
// Color Themes
// ============================================

/**
 * All available color themes with preview colors for the theme selector.
 * Each theme has both light and dark mode variants defined in CSS.
 */
export const COLOR_THEMES: ColorThemeDefinition[] = [
  {
    id: 'default',
    name: 'Vibe Teamlead',
    description: 'Instrument-panel palette shared with Meter: ink on ground, vermilion only as a signal',
    previewColors: { bg: '#E8EAE3', accent: '#D6401A', darkBg: '#1C1D19', darkAccent: '#F0613C' }
  }
];
