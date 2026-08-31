import { app, BrowserWindow } from 'electron';

/**
 * Creates a resource-note window: a split view with a browser pane on one side
 * and a note editor on the other.
 *
 * Like note windows, it reuses the main renderer bundle and selects its UI via
 * a route hash (`#/resource-note`). The URL to load in the browser pane is
 * passed along as a query param so the renderer knows what to show; it defaults
 * when omitted. The browser pane itself is an Electron `<webview>`, which runs
 * out-of-process and is therefore not subject to the renderer's strict CSP —
 * that's why `webviewTag` is enabled here.
 */
export const createResourceNoteWindow = (url?: string): BrowserWindow => {
  const resourceNoteWindow = new BrowserWindow({
    height: 700,
    width: 1100,
    title: 'Resource Note',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      // Allow the <webview> tag so the browser pane can load an external site
      // in its own process, outside the renderer's Content-Security-Policy.
      webviewTag: true,
    },
  });

  const target = url ? `?url=${encodeURIComponent(url)}` : '';
  resourceNoteWindow.loadURL(
    `${MAIN_WINDOW_WEBPACK_ENTRY}#/resource-note${target}`,
  );

  if (!app.isPackaged) {
    resourceNoteWindow.webContents.openDevTools();
  }

  return resourceNoteWindow;
};
