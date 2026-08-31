/**
 * Renderer entry point.
 *
 * This file runs in the Chromium renderer process. It is the JS entry that
 * Electron Forge's Webpack plugin injects into `index.html`. No Node.js APIs
 * are available here directly — use the `window.marginalia` bridge instead.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@ui/App';

import '@ui/index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container "#root" was not found in the document.');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
