import { app, BrowserWindow } from 'electron';

import { createMainWindow } from '@main/windows';
import { installContentSecurityPolicy } from '@main/security';
import { registerIpcHandlers } from '@main/ipc';
import { installApplicationMenu } from '@main/menu';
import { createTray } from '@main/tray';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// This package has no type definitions and is loaded for its boolean result.
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require('electron-squirrel-startup')) {
  app.quit();
}

// This method will be called when Electron has finished initialization and is
// ready to create browser windows. Some APIs can only be used after this event.
app.on('ready', () => {
  installContentSecurityPolicy();
  registerIpcHandlers();
  installApplicationMenu();
  createTray();
  createMainWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common for
// applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the dock icon is
  // clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
