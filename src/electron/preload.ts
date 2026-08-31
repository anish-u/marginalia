// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
//
// The preload script is the only place with access to both Node/Electron APIs
// and the renderer's `window`. We use `contextBridge` to expose a small,
// explicit, typed API instead of enabling nodeIntegration.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { MarginaliaApi } from '@shared/ipc';
import { IpcChannels } from '@main/ipc-channels';

const api: MarginaliaApi = {
  getAppVersion: () => ipcRenderer.invoke(IpcChannels.GetAppVersion),
  openResourceNoteWindow: (url) =>
    ipcRenderer.invoke(IpcChannels.OpenResourceNoteWindow, url),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SetTheme, theme),
  onThemeChanged: (callback) => {
    // Wrap the listener so the raw IpcRendererEvent never crosses the bridge —
    // the renderer only sees the theme string. Return a disposer so callers can
    // unsubscribe (e.g. in a React effect cleanup).
    const listener = (_event: IpcRendererEvent, theme: string) =>
      callback(theme);
    ipcRenderer.on(IpcChannels.ThemeChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ThemeChanged, listener);
  },
};

contextBridge.exposeInMainWorld('marginalia', api);
