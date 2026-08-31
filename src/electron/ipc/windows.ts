import { ipcMain } from 'electron';

import { createNoteWindow } from '@main/windows';
import { IpcChannels } from '@main/ipc-channels';

/**
 * Registers IPC handlers for window management (`window:*` channels).
 *
 * Lets the renderer ask the main process to open a new note window. Window
 * creation stays in the main process; the renderer only sends the intent.
 */
export const registerWindowHandlers = (): void => {
  ipcMain.handle(IpcChannels.OpenNoteWindow, () => {
    createNoteWindow();
  });
};
