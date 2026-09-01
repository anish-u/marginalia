import { ipcMain } from 'electron';

import { createResourceNoteWindow } from '@main/windows';
import { IpcChannels } from '@main/ipc-channels';

/**
 * Registers IPC handlers for window management (`window:*` channels).
 *
 * Lets the renderer ask the main process to open a resource-note window. Window
 * creation stays in the main process; the renderer only sends the intent.
 */
export const registerWindowHandlers = (): void => {
  ipcMain.handle(
    IpcChannels.OpenResourceNoteWindow,
    (_event, url?: string, title?: string) => {
      // A fresh note from the launcher: seed the browser pane url and the
      // note's initial title (both chosen in the "New Resource Note" dialog).
      createResourceNoteWindow(url, undefined, title);
    },
  );
};
