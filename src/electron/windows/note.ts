import { app, BrowserWindow } from 'electron';

/**
 * Creates a note window.
 *
 * Unlike the main window there can be many of these open at once — each call
 * spawns an independent note. They reuse the main renderer bundle (Electron
 * Forge's webpack plugin generates a single entry, `main_window`) but load it
 * with a `#/note` route hash so React Router renders the note UI instead of the
 * launcher. See `src/ui/App.tsx` for the routing.
 */
export const createNoteWindow = (): BrowserWindow => {
  const noteWindow = new BrowserWindow({
    height: 520,
    width: 460,
    title: 'New Note',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      // Mirror the main window's security posture.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  noteWindow.loadURL(`${MAIN_WINDOW_WEBPACK_ENTRY}#/note`);

  if (!app.isPackaged) {
    noteWindow.webContents.openDevTools();
  }

  return noteWindow;
};
