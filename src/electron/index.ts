import { app, BrowserWindow } from 'electron';

import { createMainWindow } from '@main/windows';
import { installContentSecurityPolicy } from '@main/security';
import { registerIpcHandlers } from '@main/ipc';
import { vaultManager } from '@main/ipc/vault';
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
app.on('ready', async () => {
  installContentSecurityPolicy();
  registerIpcHandlers();
  // Restore the last-active vault (best-effort) before the launcher appears, so
  // the main window's `getActiveVault()` picks it up and shows its notes rather
  // than the empty state. `restore()` silently yields `null` when there's no
  // saved pointer or the folder is no longer a readable vault — no broadcast is
  // needed on boot since no window has subscribed yet.
  await vaultManager.restore();
  installApplicationMenu();
  createTray();
  createMainWindow();
});

// Note: we intentionally do NOT broadcast `notes:changed` on window focus.
// Focus changes are not note-set changes, and a focus-time re-list produced a
// redundant broadcast to every window on every focus (multi-window-sync Req
// 3.3). External changes are still surfaced by the On_Disk_Watcher (a debounced
// `fs.watch` on the vault's `notes/` directory), and in-app writes broadcast
// explicitly from the write handlers — so no focus-based refresh is needed.

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
