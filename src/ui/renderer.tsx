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
import { initTheme } from '@ui/lib/theme';
import { installPointerCaptureGuard } from '@ui/lib/pointer-capture-guard';

import '@ui/index.css';

// Guard against an InvalidStateError thrown by react-resizable-panels'
// setPointerCapture call when a resize drag interacts with the <webview>.
installPointerCaptureGuard();

// Apply the persisted theme before first paint. index.html ships with the
// `.dark` class as a default, but every window (note, resource-note, launcher)
// reconciles to the user's saved choice here so they all match.
initTheme();

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
