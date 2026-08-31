// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
//
// The preload script is the only place with access to both Node/Electron APIs
// and the renderer's `window`. We use `contextBridge` to expose a small,
// explicit, typed API instead of enabling nodeIntegration.
import { contextBridge, ipcRenderer } from 'electron';

import type { MarginaliaApi } from '@shared/ipc';
import { IpcChannels } from '@main/ipc-channels';

const api: MarginaliaApi = {
  getAppVersion: () => ipcRenderer.invoke(IpcChannels.GetAppVersion),
  openNoteWindow: () => ipcRenderer.invoke(IpcChannels.OpenNoteWindow),
};

contextBridge.exposeInMainWorld('marginalia', api);
