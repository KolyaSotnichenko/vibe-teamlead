// Initialize browser mock before anything else (no-op in Electron)
import './lib/browser-mock';

// Initialize i18n before React
import '../shared/i18n';

// Initialize Sentry for error tracking (respects user's sentryEnabled setting)
// Fire-and-forget: React rendering proceeds immediately while Sentry initializes async
import { initSentryRenderer } from './lib/sentry';
initSentryRenderer().catch((err) => {
  console.warn('[Sentry] Failed to initialize renderer:', err);
});

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Design-system fonts, bundled (no network): Archivo for Latin, Inter Tight
// only for Cyrillic (Archivo has none), IBM Plex Mono for data.
import '@fontsource/archivo/latin-400.css';
import '@fontsource/archivo/latin-500.css';
import '@fontsource/archivo/latin-600.css';
import '@fontsource/archivo/latin-700.css';
import '@fontsource/inter-tight/cyrillic-400.css';
import '@fontsource/inter-tight/cyrillic-500.css';
import '@fontsource/inter-tight/cyrillic-600.css';
import '@fontsource/inter-tight/cyrillic-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles/globals.css';

// macOS draws the window buttons over the top-left corner (hiddenInset title bar)
if (/Mac/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'mac';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
