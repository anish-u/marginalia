import { app, BrowserWindow } from 'electron';

/**
 * Creates the application's main window.
 *
 * The `MAIN_WINDOW_*` constants are injected by Electron Forge's webpack plugin
 * (see forge-env.d.ts). Security-relevant `webPreferences` live here so all
 * window creation goes through one place.
 *
 * Each additional window (settings, about, etc.) gets its own file in this
 * folder with its own `create<Name>Window` function, re-exported from index.ts.
 */
export const createMainWindow = (): BrowserWindow => {
  const mainWindow = new BrowserWindow({
    height: 600,
    width: 800,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      // Security defaults: isolate the renderer from Node and expose the app
      // API only through the preload `contextBridge`.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools in development.
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
};
