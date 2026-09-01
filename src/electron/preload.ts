// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
//
// The preload script is the only place with access to both Node/Electron APIs
// and the renderer's `window`. We use `contextBridge` to expose a small,
// explicit, typed API instead of enabling nodeIntegration.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { MarginaliaApi, NotesChangedInfo } from '@shared/ipc';
import type { VaultInfo } from '@shared/resource-note';
import { IpcChannels } from '@main/ipc-channels';

const api: MarginaliaApi = {
  getAppVersion: () => ipcRenderer.invoke(IpcChannels.GetAppVersion),
  openResourceNoteWindow: (url, title) =>
    ipcRenderer.invoke(IpcChannels.OpenResourceNoteWindow, url, title),
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

  // --- Vault + notes persistence ---
  // Each of these forwards to a `ipcMain.handle` in a `src/electron/ipc/*`
  // domain module; the renderer never touches the filesystem directly.
  createVault: () => ipcRenderer.invoke(IpcChannels.VaultCreate),
  openVault: () => ipcRenderer.invoke(IpcChannels.VaultOpen),
  getActiveVault: () => ipcRenderer.invoke(IpcChannels.VaultGetActive),
  onVaultChanged: (callback) => {
    // Mirrors `onThemeChanged`: unwrap the IpcRendererEvent so only the new
    // vault (or `null` when cleared) crosses the bridge, and return a disposer
    // for effect cleanup (Req 3.3).
    const listener = (_event: IpcRendererEvent, vault: VaultInfo | null) =>
      callback(vault);
    ipcRenderer.on(IpcChannels.VaultChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannels.VaultChanged, listener);
  },
  listNotes: () => ipcRenderer.invoke(IpcChannels.NotesList),
  readNote: (id) => ipcRenderer.invoke(IpcChannels.NoteRead, id),
  writeNote: (note) => ipcRenderer.invoke(IpcChannels.NoteWrite, note),
  deleteNote: (id) => ipcRenderer.invoke(IpcChannels.NoteDelete, id),
  renameNote: (id, title) =>
    ipcRenderer.invoke(IpcChannels.NoteRename, id, title),
  allocateNoteId: (title) =>
    ipcRenderer.invoke(IpcChannels.NoteAllocateId, title),
  openNoteWindow: (id) => ipcRenderer.invoke(IpcChannels.OpenNoteWindow, id),
  onNotesChanged: (callback) => {
    // Mirrors `onVaultChanged`: the main process fans out `NotesChanged` to
    // every window after a note is written/deleted/renamed. The payload is the
    // `{ oldId, newId }` rename info (or null); unwrap the IpcRendererEvent so
    // only that crosses the bridge, and return a disposer for effect cleanup.
    const listener = (
      _event: IpcRendererEvent,
      rename: NotesChangedInfo | null,
    ) => callback(rename);
    ipcRenderer.on(IpcChannels.NotesChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannels.NotesChanged, listener);
  },
};

contextBridge.exposeInMainWorld('marginalia', api);
