import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@main/ipc-channels';

/**
 * Registers IPC handlers for theme sync (`theme:*` channels).
 *
 * Each window is its own renderer process, and the browser `storage` event does
 * not reliably propagate between separate Electron BrowserWindows. So instead of
 * relying on localStorage broadcasting, a window that changes the theme sends it
 * to the main process, which fans it out to every *other* open window via
 * `webContents.send`. The sender is skipped because it already applied the
 * change locally.
 */
export const registerThemeHandlers = (): void => {
  ipcMain.handle(IpcChannels.SetTheme, (event, theme: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.id === event.sender.id) continue;
      win.webContents.send(IpcChannels.ThemeChanged, theme);
    }
  });
};
