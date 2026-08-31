import { app, ipcMain } from 'electron';

import { IpcChannels } from '@main/ipc-channels';

/**
 * Registers IPC handlers for app metadata (`app:*` channels).
 *
 * Each feature domain gets its own `registerXHandlers` function like this, and
 * they're composed together in ./index.ts. Keeping one file per domain means
 * this file only ever grows with app-info concerns.
 */
export const registerAppInfoHandlers = (): void => {
  ipcMain.handle(IpcChannels.GetAppVersion, () => app.getVersion());
};
